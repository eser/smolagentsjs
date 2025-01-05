/**
 * @fileoverview Model implementations for smolagentsjs
 * @license Apache-2.0
 */

import { Tool } from './tools.js';
import { parseJsonToolCall } from './utils.js';
import { HfInference } from '@huggingface/inference';
import { AutoTokenizer, AutoModelForCausalLM } from '@huggingface/transformers';
import litellm from 'litellm';

// Default grammar patterns
export const DEFAULT_JSONAGENT_REGEX_GRAMMAR = {
  type: 'regex',
  value: 'Thought: .+?\\nAction:\\n\\{\\n\\s{4}"action":\\s"[^"\\n]+",\\n\\s{4}"action_input":\\s"[^"\\n]+"\\n\\}\\n<end_action>'
};

export const DEFAULT_CODEAGENT_REGEX_GRAMMAR = {
  type: 'regex',
  value: 'Thought: .+?\\nCode:\\n```(?:js|javascript)?\\n(?:.|\\s)+?\\n```<end_action>'
};

/**
 * Message roles enum
 */
export const MessageRole = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  TOOL_CALL: 'tool-call',
  TOOL_RESPONSE: 'tool-response',
  
  roles() {
    return Object.values(this).filter(role => typeof role === 'string');
  }
};

// Role conversions for tool interactions
export const toolRoleConversions = {
  [MessageRole.TOOL_CALL]: MessageRole.ASSISTANT,
  [MessageRole.TOOL_RESPONSE]: MessageRole.USER
};

/**
 * Get JSON schema for a tool
 * @param {Tool} tool - Tool to get schema for
 * @returns {Object} JSON schema
 */
export function getJsonSchema(tool) {
  const properties = structuredClone(tool.inputs);
  const required = [];
  
  for (const [key, value] of Object.entries(properties)) {
    if (value.type === 'any') {
      value.type = 'string';
    }
    if (!('nullable' in value && value.nullable)) {
      required.push(key);
    }
  }
  
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties,
        required
      }
    }
  };
}

/**
 * Remove stop sequences from content
 * @param {string} content - Content to clean
 * @param {Array<string>} stopSequences - Stop sequences to remove
 * @returns {string} Cleaned content
 */
export function removeStopSequences(originalContent, stopSequences) {
  let content = originalContent;
  for (const stopSeq of stopSequences) {
    if (content.slice(-stopSeq.length) === stopSeq) {
      content = content.slice(0, -stopSeq.length);
    }
  }
  return content;
}

/**
 * Clean and normalize message list
 * @param {Array<Object>} messageList - List of messages
 * @param {Object} roleConversions - Role conversion mapping
 * @returns {Array<Object>} Cleaned message list
 */
export function getCleanMessageList(originalMessageList, roleConversions = {}) {
  const finalMessageList = [];
  const messageList = structuredClone(originalMessageList);

  for (const message of messageList) {
    const role = message.role;
    if (!MessageRole.roles().includes(role)) {
      throw new Error(`Incorrect role ${role}, only ${MessageRole.roles()} are supported for now.`);
    }

    if (role in roleConversions) {
      message.role = roleConversions[role];
    }

    if (finalMessageList.length > 0 && message.role === finalMessageList[finalMessageList.length - 1].role) {
      finalMessageList[finalMessageList.length - 1].content = `${finalMessageList[finalMessageList.length - 1].content}\n=======\n${message.content}`;
    } else {
      finalMessageList.push(message);
    }
  }
  
  return finalMessageList;
}

/**
 * Base model class
 */
export class Model {
  constructor() {
    this.lastInputTokenCount = null;
    this.lastOutputTokenCount = null;
  }

  getTokenCounts() {
    return {
      inputTokenCount: this.lastInputTokenCount,
      outputTokenCount: this.lastOutputTokenCount
    };
  }

  /**
   * Generate text from messages
   * @param {Array<Object>} messages - Input messages
   * @param {Array<string>} stopSequences - Stop sequences
   * @param {string} grammar - Grammar pattern
   * @param {number} maxTokens - Max tokens to generate
   * @returns {string} Generated text
   */
  generate(messages, stopSequences = null, grammar = null, maxTokens = 1500) {
    throw new Error('Not implemented');
  }

  /**
   * Process messages and return response
   * @param {Array<Object>} messages - Input messages
   * @param {Array<string>} stopSequences - Stop sequences
   * @param {string} grammar - Grammar pattern
   * @param {number} maxTokens - Max tokens to generate
   * @returns {string} Model response
   */
  call(messages, stopSequences = null, grammar = null, maxTokens = 1500) {
    if (!Array.isArray(messages)) {
      throw new Error('Messages should be a list of dictionaries with "role" and "content" keys.');
    }
    
    const sequences = stopSequences || [];
    const response = this.generate(messages, sequences, grammar, maxTokens);
    return removeStopSequences(response, sequences);
  }
}

/**
 * Hugging Face API model implementation
 */
export class HfApiModel extends Model {
  /**
   * @param {string} modelId - Model ID to use
   * @param {string} token - HF API token
   * @param {number} timeout - API timeout in seconds
   */
  constructor(modelId = 'Qwen/Qwen2.5-Coder-32B-Instruct', token = null, timeout = 120) {
    super();
    this.modelId = modelId;
    const apiToken = token || process.env.HF_TOKEN;
    this.client = new HfInference(apiToken);
  }

  /**
   * Generate text from messages
   * @param {Array<Object>} messages - Input messages
   * @param {Array<string>} stopSequences - Stop sequences
   * @param {string} grammar - Grammar pattern
   * @param {number} maxTokens - Max tokens to generate
   * @returns {string} Generated text
   */
  async generate(messages, stopSequences = null, grammar = null, maxTokens = 1500) {
    const cleanMessages = getCleanMessageList(messages, toolRoleConversions);

    let output;
    if (grammar) {
      output = await this.client.chatCompletion(cleanMessages, {
        model: this.modelId,
        stop: stopSequences,
        responseFormat: grammar,
        maxTokens
      });
    } else {
      output = await this.client.chat.completions.create({
        model: this.modelId,
        messages: cleanMessages,
        stop: stopSequences,
        maxTokens
      });
    }

    const response = output.choices[0].message.content;
    this.lastInputTokenCount = output.usage.promptTokens;
    this.lastOutputTokenCount = output.usage.completionTokens;
    return response;
  }

  /**
   * Get tool call from messages
   * @param {Array<Object>} messages - Input messages
   * @param {Array<Tool>} availableTools - Available tools
   * @param {Array<string>} stopSequences - Stop sequences
   * @returns {Promise<Array>} Tool call details
   */
  async getToolCall(messages, availableTools, stopSequences) {
    const cleanMessages = getCleanMessageList(messages, toolRoleConversions);
    
    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages: cleanMessages,
      tools: availableTools.map(getJsonSchema),
      toolChoice: 'auto',
      stop: stopSequences
    });

    const toolCall = response.choices[0].message.toolCalls[0];
    this.lastInputTokenCount = response.usage.promptTokens;
    this.lastOutputTokenCount = response.usage.completionTokens;
    
    return [toolCall.function.name, toolCall.function.arguments, toolCall.id];
  }
}

/**
 * LiteLLM model implementation
 */
export class LiteLLMModel extends Model {
  /**
   * @param {string} modelId - Model ID to use
   * @param {string} apiBase - API base URL
   * @param {string} apiKey - API key
   */
  constructor(modelId = 'anthropic/claude-3-5-sonnet-20240620', apiBase = null, apiKey = null) {
    super();
    this.modelId = modelId;
    this.apiBase = apiBase;
    this.apiKey = apiKey;
    
    // IMPORTANT - Set this to TRUE to add the function to the prompt for Non OpenAI LLMs
    this.litellm = litellm;
    this.litellm.addFunctionToPrompt = true;
  }

  /**
   * Process messages and return response
   * @param {Array<Object>} messages - Input messages
   * @param {Array<string>} stopSequences - Stop sequences
   * @param {string} grammar - Grammar pattern
   * @param {number} maxTokens - Max tokens to generate
   * @returns {Promise<string>} Model response
   */
  async call(messages, stopSequences = null, grammar = null, maxTokens = 1500) {
    const cleanMessages = getCleanMessageList(messages, toolRoleConversions);
    
    const response = await this.litellm.completion({
      model: this.modelId,
      messages: cleanMessages,
      stop: stopSequences,
      maxTokens,
      apiBase: this.apiBase,
      apiKey: this.apiKey
    });

    this.lastInputTokenCount = response.usage.promptTokens;
    this.lastOutputTokenCount = response.usage.completionTokens;
    return response.choices[0].message.content;
  }

  /**
   * Get tool call from messages
   * @param {Array<Object>} messages - Input messages
   * @param {Array<Tool>} availableTools - Available tools
   * @param {Array<string>} stopSequences - Stop sequences
   * @param {number} maxTokens - Max tokens to generate
   * @returns {Promise<Array>} Tool call details
   */
  async getToolCall(messages, availableTools, stopSequences = null, maxTokens = 1500) {
    const cleanMessages = getCleanMessageList(messages, toolRoleConversions);
    
    try {
      const response = await this.litellm.completion({
        model: this.modelId,
        messages: cleanMessages,
        tools: availableTools.map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        })),
        tool_choice: { type: "function" },
        stop: stopSequences,
        max_tokens: maxTokens,
        api_base: this.apiBase,
        api_key: this.apiKey
      });

      if (!response.choices?.[0]?.message?.tool_calls?.[0]) {
        throw new Error('No tool call in response');
      }

      const toolCall = response.choices[0].message.tool_calls[0];
      this.lastInputTokenCount = response.usage?.prompt_tokens || 0;
      this.lastOutputTokenCount = response.usage?.completion_tokens || 0;
      
      let toolArgs;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch (e) {
        console.warn('Failed to parse tool arguments:', toolCall.function.arguments);
        toolArgs = toolCall.function.arguments;
      }

      return [toolCall.function.name, toolArgs, toolCall.id];
    } catch (e) {
      console.error('LiteLLM completion error:', e);
      throw e;
    }
  }
}

/**
 * Transformers model implementation
 */
export class TransformersModel extends Model {
  /**
   * @param {string} modelId - Model ID to use
   */
  constructor(modelId = null) {
    super();
    const defaultModelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
    const selectedModelId = modelId || defaultModelId;
    if (!modelId) {
      console.warn(`modelId not provided, using this default tokenizer for token counts: '${selectedModelId}'`);
    }
    this.modelId = selectedModelId;

    try {
      this.tokenizer = AutoTokenizer.fromPretrained(selectedModelId);
      this.model = AutoModelForCausalLM.fromPretrained(selectedModelId);
    } catch (error) {
      console.warn(`Failed to load tokenizer and model for modelId=${selectedModelId}: ${error}. Loading default tokenizer and model instead from modelId=${defaultModelId}.`);
      this.tokenizer = AutoTokenizer.fromPretrained(defaultModelId);
      this.model = AutoModelForCausalLM.fromPretrained(defaultModelId);
    }
  }

  /**
   * Create stopping criteria for generation
   * @param {Array<string>} stopSequences - Stop sequences
   * @returns {Object} Stopping criteria
   */
  makeStoppingCriteria(stopSequences) {
    class StopOnStrings {
      constructor(stopStrings, tokenizer) {
        this.stopStrings = stopStrings;
        this.tokenizer = tokenizer;
        this.stream = '';
      }

      reset() {
        this.stream = '';
      }

      call(inputIds, scores) {
        const generated = this.tokenizer.decode(inputIds[0].slice(-1), { skipSpecialTokens: true });
        this.stream += generated;
        return this.stopStrings.some(stopString => this.stream.endsWith(stopString));
      }
    }

    return [new StopOnStrings(stopSequences, this.tokenizer)];
  }

  /**
   * Generate text from messages
   * @param {Array<Object>} messages - Input messages
   * @param {Array<string>} stopSequences - Stop sequences
   * @param {string} grammar - Grammar pattern
   * @param {number} maxTokens - Max tokens to generate
   * @returns {Promise<string>} Generated text
   */
  async generate(messages, stopSequences = null, grammar = null, maxTokens = 1500) {
    const cleanMessages = getCleanMessageList(messages, toolRoleConversions);

    const prompt = await this.tokenizer.applyChatTemplate(cleanMessages, {
      returnTensors: 'pt',
      returnDict: true
    });
    prompt.to(this.model.device);
    const countPromptTokens = prompt.inputIds.shape[1];

    const out = await this.model.generate({
      ...prompt,
      maxNewTokens: maxTokens,
      stoppingCriteria: stopSequences ? this.makeStoppingCriteria(stopSequences) : null
    });

    const generatedTokens = out[0].slice(countPromptTokens);
    const response = await this.tokenizer.decode(generatedTokens, { skipSpecialTokens: true });

    this.lastInputTokenCount = countPromptTokens;
    this.lastOutputTokenCount = generatedTokens.length;

    return stopSequences ? removeStopSequences(response, stopSequences) : response;
  }

  /**
   * Get tool call from messages
   * @param {Array<Object>} messages - Input messages
   * @param {Array<Tool>} availableTools - Available tools
   * @param {Array<string>} stopSequences - Stop sequences
   * @param {number} maxTokens - Max tokens to generate
   * @returns {Promise<Array>} Tool call details
   */
  async getToolCall(messages, availableTools, stopSequences = null, maxTokens = 500) {
    const cleanMessages = getCleanMessageList(messages, toolRoleConversions);

    const prompt = await this.tokenizer.applyChatTemplate(cleanMessages, {
      tools: availableTools.map(getJsonSchema),
      returnTensors: 'pt',
      returnDict: true,
      addGenerationPrompt: true
    });
    prompt.to(this.model.device);
    const countPromptTokens = prompt.inputIds.shape[1];

    const out = await this.model.generate({
      ...prompt,
      maxNewTokens: maxTokens,
      stoppingCriteria: stopSequences ? this.makeStoppingCriteria(stopSequences) : null
    });

    const generatedTokens = out[0].slice(countPromptTokens);
    const response = await this.tokenizer.decode(generatedTokens, { skipSpecialTokens: true });

    this.lastInputTokenCount = countPromptTokens;
    this.lastOutputTokenCount = generatedTokens.length;

    const cleanResponse = stopSequences ? removeStopSequences(response, stopSequences) : response;
    const [toolName, toolInput] = parseJsonToolCall(cleanResponse);
    const callId = Array.from({ length: 5 }, () => Math.floor(Math.random() * 10)).join('');

    return [toolName, toolInput, callId];
  }
}
