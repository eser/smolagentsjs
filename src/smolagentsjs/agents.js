import { Tool, Toolbox } from './tools.js';
import { MessageRole } from './models.js';
import { truncateContent, AgentParsingError, AgentExecutionError, AgentMaxIterationsError } from './utils.js';
import { Monitor } from './monitoring.js';
import { parseCodeBlob } from './utils.js';
import { LocalNodeInterpreter, BASE_BUILTIN_MODULES } from './local_nodejs_executor.js';
import { CODE_SYSTEM_PROMPT, TOOL_CALLING_SYSTEM_PROMPT, MANAGED_AGENT_PROMPT } from './prompts.js';
import { SystemPromptStep } from './steps.js';

export class MultiStepAgent {
  constructor({
    tools,
    model,
    systemPrompt = null,
    toolDescriptionTemplate = null,
    maxIterations = 6,
    toolParser = null,
    addBaseTools = false,
    verbose = false,
    grammar = null,
    managedAgents = null,
    stepCallbacks = null,
    planningInterval = null
  }) {
    this.agentName = this.constructor.name;
    this.model = model;
    this.systemPromptTemplate = systemPrompt;
    this.toolDescriptionTemplate = toolDescriptionTemplate;
    this.maxIterations = maxIterations;
    this.toolParser = toolParser;
    this.grammar = grammar;
    this.planningInterval = planningInterval;
    this.state = {};

    this.managedAgents = {};
    if (managedAgents) {
      this.managedAgents = Object.fromEntries(
        managedAgents.map(agent => [agent.name, agent])
      );
    }

    if (tools instanceof Toolbox) {
      this._toolbox = tools;
      if (addBaseTools) {
        this._toolbox.addBaseTools();
      }
    } else {
      this._toolbox = new Toolbox(tools, addBaseTools);
    }

    this.systemPrompt = this.initializeSystemPrompt();
    this.inputMessages = null;
    this.logs = [];
    this.task = null;
    this.verbose = verbose;
    this.monitor = new Monitor(this.model);
    this.stepCallbacks = stepCallbacks || [];
    this.stepCallbacks.push(this.monitor.updateMetrics.bind(this.monitor));
  }

  get toolbox() {
    return this._toolbox;
  }

  initializeSystemPrompt() {
    this.systemPrompt = this.formatPromptWithTools(
      this._toolbox,
      this.systemPromptTemplate,
      this.toolDescriptionTemplate
    );
    this.systemPrompt = this.formatPromptWithManagedAgentsDescriptions(
      this.systemPrompt,
      this.managedAgents
    );
    return this.systemPrompt;
  }

  formatPromptWithTools(toolbox, promptTemplate, toolDescriptionTemplate) {
    const toolDescriptions = toolbox.showToolDescriptions(toolDescriptionTemplate);
    let prompt = promptTemplate.replace("{{tool_descriptions}}", toolDescriptions);

    if (prompt.includes("{{tool_names}}")) {
      prompt = prompt.replace(
        "{{tool_names}}",
        Array.from(toolbox.tools.keys()).map(name => `'${name}'`).join(", ")
      );
    }

    return prompt;
  }

  formatPromptWithManagedAgentsDescriptions(
    promptTemplate,
    managedAgents,
    placeholder = "{{managedAgentsDescriptions}}"
  ) {
    if (!promptTemplate.includes(placeholder)) {
      console.log("PROMPT TEMPLLL", promptTemplate);
      throw new Error(
        `Provided prompt template does not contain the managed agents descriptions placeholder '${placeholder}'`
      );
    }

    if (Object.keys(managedAgents).length === 0) {
      return promptTemplate.replace(placeholder, "");
    }
    
      return promptTemplate.replace(
        placeholder,
        this.showAgentsDescriptions(managedAgents)
      );
  }

  showAgentsDescriptions(managedAgents) {
    let desc = `
You can also give requests to team members.
Calling a team member works the same as for calling a tool: simply, the only argument you can give in the call is 'request', a long string explaning your request.
Given that this team member is a real human, you should be very verbose in your request.
Here is a list of the team members that you can call:`;
    
    for (const agent of Object.values(managedAgents)) {
      desc += `\n- ${agent.name}: ${agent.description}`;
    }
    return desc;
  }

  writeInnerMemoryFromLogs(summaryMode = false) {
    const memory = [];
    
    for (const stepLog of this.logs) {
      if (stepLog instanceof SystemPromptStep) {
        if (!summaryMode) {
          memory.push({
            role: MessageRole.SYSTEM,
            content: stepLog.systemPrompt.trim()
          });
        }
      } else if (stepLog instanceof PlanningStep) {
        memory.push({
          role: MessageRole.ASSISTANT,
          content: `[FACTS LIST]:\n${stepLog.facts.trim()}`
        });

        if (!summaryMode) {
          memory.push({
            role: MessageRole.ASSISTANT,
            content: `[PLAN]:\n${stepLog.plan.trim()}`
          });
        }
      } else if (stepLog instanceof TaskStep) {
        memory.push({
          role: MessageRole.USER,
          content: `New task:\n${stepLog.task}`
        });
      } else if (stepLog instanceof ActionStep) {
        if (stepLog.llmOutput && !summaryMode) {
          memory.push({
            role: MessageRole.ASSISTANT,
            content: stepLog.llmOutput.trim()
          });
        }

        if (stepLog.toolCall) {
          memory.push({
            role: MessageRole.ASSISTANT,
            content: JSON.stringify([{
              id: stepLog.toolCall.id,
              type: "function",
              function: {
                name: stepLog.toolCall.name,
                arguments: stepLog.toolCall.arguments
              }
            }])
          });
        }

        if (!stepLog.toolCall && stepLog.error) {
          const messageContent = `Error:\n${stepLog.error}\nNow let's retry: take care not to repeat previous errors! If you have retried several times, try a completely different approach.\n`;
          memory.push({
            role: MessageRole.ASSISTANT,
            content: messageContent
          });
        }

        if (stepLog.toolCall && (stepLog.error || stepLog.observations)) {
          let messageContent;
          if (stepLog.error) {
            messageContent = `Error:\n${stepLog.error}\nNow let's retry: take care not to repeat previous errors! If you have retried several times, try a completely different approach.\n`;
          } else if (stepLog.observations) {
            messageContent = `Observation:\n${stepLog.observations}`;
          }
          memory.push({
            role: MessageRole.TOOL_RESPONSE,
            content: `Call id: ${stepLog.toolCall.id || 'call_0'}\n${messageContent}`
          });
        }
      }
    }

    return memory;
  }

  getSuccinctLogs() {
    return this.logs.map(log => {
      const { agentMemory, ...rest } = log;
      return rest;
    });
  }

  async executeToolCall(toolName, toolArgs) {
    const availableTools = {
      ...this.toolbox.tools,
      ...this.managedAgents
    };

    if (!(toolName in availableTools)) {
      throw new AgentExecutionError(
        `Unknown tool ${toolName}, should be instead one of ${Object.keys(availableTools)}.`
      );
    }

    try {
      let observation;
      if (typeof toolArgs === 'string') {
        observation = await availableTools[toolName].__call__(toolArgs, true);
      } else if (typeof toolArgs === 'object') {
        const processedArgs = { ...toolArgs };
        for (const [key, value] of Object.entries(processedArgs)) {
          if (typeof value === 'string' && value in this.state) {
            processedArgs[key] = this.state[value];
          }
        }
        observation = await availableTools[toolName].__call__({ ...processedArgs, sanitizeInputsOutputs: true });
      } else {
        throw new AgentExecutionError(
          `Arguments passed to tool should be a dict or string: got a ${typeof toolArgs}.`
        );
      }
      return observation;
    } catch (e) {
      if (toolName in this.toolbox.tools) {
        const toolDescription = this.toolbox.getToolDescriptionWithArgs(availableTools[toolName]);
        throw new AgentExecutionError(
          `Error in tool call execution: ${e}
You should only use this tool with a correct input.
As a reminder, this tool's description is the following:
${toolDescription}`
        );
      }
      throw new AgentExecutionError(
        `Error in calling team member: ${e}
You should only ask this team member with a correct request.
As a reminder, this team member's description is the following:
${availableTools[toolName]}`
      );
    }
  }

  async provideFinalAnswer(task) {
    try {
      const messages = [
        {
          role: MessageRole.SYSTEM,
          content: "An agent tried to answer a user query but it got stuck and failed to do so. You are tasked with providing an answer instead. Here is the agent's memory:"
        },
        ...this.writeInnerMemoryFromLogs().slice(1),
        {
          role: MessageRole.USER,
          content: `Based on the above, please provide an answer to the following user request:\n${task}`
        }
      ];

      if (typeof this.model.call === 'function') {
        return await this.model.call(messages);
      }

      if (typeof this.model === 'function') {
        return await this.model(messages);
      }

      throw new Error('Model must be either a function or an object with a call method');
    } catch (e) {
      return `Error in generating final LLM output:\n${e}`;
    }
  }

  async run(task, {
    stream = false,
    reset = true,
    singleStep = false,
    additionalArgs = null
  } = {}) {
    this.task = task;
    if (additionalArgs) {
      this.state = { ...this.state, ...additionalArgs };
      this.task += `
You have been provided with these additional arguments, that you can access using the keys as variables in your python code:
${JSON.stringify(additionalArgs)}.`;
    }

    this.initializeSystemPrompt();
    const systemPromptStep = { systemPrompt: this.systemPrompt };

    if (reset) {
      this.logs = [systemPromptStep];
      this.monitor.reset();
    } else {
      if (this.logs.length > 0) {
        this.logs[0] = systemPromptStep;
      } else {
        this.logs.push(systemPromptStep);
      }
    }

    console.log(
      `New run\n${this.task.trim()}\n${this.model.constructor.name} - ${this.model.modelId || ''}`
    );

    this.logs.push({ task: this.task });

    if (singleStep) {
      const stepStartTime = Date.now();
      const stepLog = {
        startTime: stepStartTime
      };
      stepLog.endTime = Date.now();
      stepLog.duration = stepLog.endTime - stepLog.startTime;

      const result = await this.step(stepLog);
      return result;
    }

    return stream ? this.streamRun(this.task) : this.directRun(this.task);
  }

  async *streamRun(task) {
    let finalAnswer = null;
    let iteration = 0;

    while (finalAnswer === null && iteration < this.maxIterations) {
      const stepStartTime = Date.now();
      const stepLog = {
        iteration,
        startTime: stepStartTime
      };

      try {
        if (this.planningInterval && iteration % this.planningInterval === 0) {
          await this.planningStep(task, iteration === 0, iteration);
        }
        console.log(`Step ${iteration}`);

        finalAnswer = await this.step(stepLog);
      } catch (e) {
        stepLog.error = e;
      } finally {
        stepLog.endTime = Date.now();
        stepLog.duration = stepLog.endTime - stepLog.startTime;
        this.logs.push(stepLog);
        for (const callback of this.stepCallbacks) {
          await callback(stepLog);
        }
        iteration++;
        yield stepLog;
      }
    }

    if (finalAnswer === null && iteration === this.maxIterations) {
      const errorMessage = "Reached max iterations.";
      const finalStepLog = {
        error: new AgentMaxIterationsError(errorMessage)
      };
      this.logs.push(finalStepLog);
      finalAnswer = await this.provideFinalAnswer(task);
      console.log(`Final answer: ${finalAnswer}`);
      finalStepLog.actionOutput = finalAnswer;
      finalStepLog.endTime = Date.now();
      finalStepLog.duration = finalStepLog.endTime - stepStartTime;
      for (const callback of this.stepCallbacks) {
        await callback(finalStepLog);
      }
      yield finalStepLog;
    }

    yield this.handleAgentOutputTypes(finalAnswer);
  }

  async directRun(task) {
    let finalAnswer = null;
    let iteration = 0;
    let stepStartTime;

    while (finalAnswer === null && iteration < this.maxIterations) {
      stepStartTime = Date.now();
      const stepLog = {
        iteration,
        startTime: stepStartTime
      };

      try {
        if (this.planningInterval && iteration % this.planningInterval === 0) {
          await this.planningStep(task, iteration === 0, iteration);
        }
        console.log(`Step ${iteration}`);

        finalAnswer = await this.step(stepLog);
      } catch (e) {
        stepLog.error = e;
      } finally {
        const stepEndTime = Date.now();
        stepLog.endTime = stepEndTime;
        stepLog.duration = stepEndTime - stepStartTime;
        this.logs.push(stepLog);
        for (const callback of this.stepCallbacks) {
          await callback(stepLog);
        }
        iteration++;
      }
    }

    if (finalAnswer === null && iteration === this.maxIterations) {
      const errorMessage = "Reached max iterations.";
      const finalStepLog = {
        error: new AgentMaxIterationsError(errorMessage)
      };
      this.logs.push(finalStepLog);
      finalAnswer = await this.provideFinalAnswer(task);
      console.log(`Final answer: ${finalAnswer}`);
      finalStepLog.actionOutput = finalAnswer;
      finalStepLog.duration = 0;
      for (const callback of this.stepCallbacks) {
        await callback(finalStepLog);
      }
    }

    return this.handleAgentOutputTypes(finalAnswer);
  }

  async planningStep(task, isFirstStep, iteration) {
    if (isFirstStep) {
      const messagePromptFacts = {
        role: MessageRole.SYSTEM,
        content: SYSTEM_PROMPT_FACTS
      };
      const messagePromptTask = {
        role: MessageRole.USER,
        content: `Here is the task:
\`\`\`
${task}
\`\`\`
Now begin!`
      };

      const answerFacts = await this.model([messagePromptFacts, messagePromptTask]);

      const messageSystemPromptPlan = {
        role: MessageRole.SYSTEM,
        content: SYSTEM_PROMPT_PLAN
      };
      const messageUserPromptPlan = {
        role: MessageRole.USER,
        content: USER_PROMPT_PLAN.replace(
          "{task}",
          task
        ).replace(
          "{toolDescriptions}",
          this._toolbox.showToolDescriptions(this.toolDescriptionTemplate)
        ).replace(
          "{managedAgentsDescriptions}",
          this.showAgentsDescriptions(this.managedAgents)
        ).replace(
          "{answerFacts}",
          answerFacts
        )
      };

      const answerPlan = await this.model(
        [messageSystemPromptPlan, messageUserPromptPlan],
        { stopSequences: ["<end_plan>"] }
      );

      const finalPlanRedaction = `Here is the plan of action that I will follow to solve the task:
\`\`\`
${answerPlan}
\`\`\``;
      const finalFactsRedaction = `Here are the facts that I know so far:
\`\`\`
${answerFacts}
\`\`\``.trim();

      this.logs.push({
        plan: finalPlanRedaction,
        facts: finalFactsRedaction
      });
      console.log("Initial plan", finalPlanRedaction);
    } else {
      const agentMemory = this.writeInnerMemoryFromLogs(false);

      const factsUpdateSystemPrompt = {
        role: MessageRole.SYSTEM,
        content: SYSTEM_PROMPT_FACTS_UPDATE
      };
      const factsUpdateMessage = {
        role: MessageRole.USER,
        content: USER_PROMPT_FACTS_UPDATE
      };
      const factsUpdate = await this.model(
        [factsUpdateSystemPrompt, ...agentMemory, factsUpdateMessage]
      );

      const planUpdateMessage = {
        role: MessageRole.SYSTEM,
        content: SYSTEM_PROMPT_PLAN_UPDATE.replace("{task}", task)
      };
      const planUpdateMessageUser = {
        role: MessageRole.USER,
        content: USER_PROMPT_PLAN_UPDATE.replace(
          "{task}",
          task
        ).replace(
          "{toolDescriptions}",
          this._toolbox.showToolDescriptions(this.toolDescriptionTemplate)
        ).replace(
          "{managedAgentsDescriptions}",
          this.showAgentsDescriptions(this.managedAgents)
        ).replace(
          "{factsUpdate}",
          factsUpdate
        ).replace(
          "{remainingSteps}",
          this.maxIterations - iteration
        )
      };

      const planUpdate = await this.model(
        [planUpdateMessage, ...agentMemory, planUpdateMessageUser],
        { stopSequences: ["<end_plan>"] }
      );

      const finalPlanRedaction = PLAN_UPDATE_FINAL_PLAN_REDACTION.replace(
        "{task}",
        task
      ).replace(
        "{planUpdate}",
        planUpdate
      );
      const finalFactsRedaction = `Here is the updated list of the facts that I know:
\`\`\`
${factsUpdate}
\`\`\``;

      this.logs.push({
        plan: finalPlanRedaction,
        facts: finalFactsRedaction
      });
      console.log("Updated plan", finalPlanRedaction);
    }
  }

  handleAgentOutputTypes(output) {
    // TODO: Implement type handling similar to Python version
    return output;
  }

  async step(logEntry) {
    throw new Error('Tool must implement step() method');
  }
}

export class ToolCallingAgent extends MultiStepAgent {
  constructor({
    tools,
    model,
    systemPrompt = TOOL_CALLING_SYSTEM_PROMPT,
    planningInterval = null,
    ...rest
  }) {
    super({
      tools,
      model,
      systemPrompt,
      planningInterval,
      ...rest
    });
  }

  async step(logEntry) {
    const agentMemory = this.writeInnerMemoryFromLogs();
    this.inputMessages = agentMemory;
    logEntry.agentMemory = [...agentMemory];

    try {
      if (typeof this.model.getToolCall !== 'function') {
        throw new Error('Model must implement getToolCall method');
      }

      let toolName, toolArguments, toolCallId;
      
      try {
        const tools = Array.from(this.toolbox.tools.values());
        const availableTools = tools.map(tool => {
          if (typeof tool === 'function') {
            return {
              name: tool.name || 'unnamed_tool',
              description: tool.description || '',
              parameters: tool.parameters || {}
            };
          }
          
          if (tool instanceof Tool) {
            return {
              name: tool.name,
              description: tool.description,
              parameters: {
                type: 'object',
                properties: tool.inputs || {},
                required: Object.keys(tool.inputs || {}).filter(k => 
                  !tool.inputs[k].optional
                )
              }
            };
          }

          console.warn('Invalid tool object:', tool);
          return null;
        }).filter(Boolean);

        if (availableTools.length === 0) {
          throw new Error('No valid tools available');
        }

        console.log('Available tools:', JSON.stringify(availableTools, null, 2));

        [toolName, toolArguments, toolCallId] = await this.model.getToolCall(
          this.inputMessages,
          availableTools,
          ["Observation:"]
        );
      } catch (e) {
        console.error('Error calling getToolCall:', e);
        throw new AgentGenerationError(`Error in tool call generation: ${e.message}`);
      }

      if (!toolName) {
        throw new AgentGenerationError('No tool name returned from model');
      }

      logEntry.toolCall = {
        name: toolName,
        arguments: toolArguments,
        id: toolCallId || `call_${this.logs.length}`
      };

      console.log(`Calling tool: '${toolName}' with arguments: ${JSON.stringify(toolArguments)}`);

      if (toolName === 'final_answer') {
        let answer = toolArguments;
        if (typeof toolArguments === 'object' && 'answer' in toolArguments) {
          answer = toolArguments.answer;
        }

        if (typeof answer === 'string' && answer in this.state) {
          const finalAnswer = this.state[answer];
          console.log(`Final answer: Extracting key '${answer}' from state to return value '${finalAnswer}'.`);
          logEntry.actionOutput = finalAnswer;
          return finalAnswer;
        }

        console.log(`Final answer: ${answer}`);
        logEntry.actionOutput = answer;
        return answer;
      }

      const observation = await this.executeToolCall(toolName, toolArguments);
      let updatedInformation;

      if (observation instanceof AgentImage) {
        const observationName = 'image.png';
        this.state[observationName] = observation;
        updatedInformation = `Stored '${observationName}' in memory.`;
      } else {
        updatedInformation = String(observation).trim();
      }

      console.log(`Observations: ${updatedInformation}`);
      logEntry.observations = updatedInformation;
      return null;

    } catch (e) {
      throw new AgentGenerationError(`Error in generating tool call with model:\n${e}`);
    }
  }

  writeInnerMemoryFromLogs(summaryMode = false) {
    const memory = [];
    
    memory.push({
      role: MessageRole.SYSTEM,
      content: this.systemPrompt
    });

    for (const log of this.logs) {
      if (log.task) {
        memory.push({
          role: MessageRole.USER,
          content: log.task
        });
      }

      if (log.llmOutput && !summaryMode) {
        memory.push({
          role: MessageRole.ASSISTANT,
          content: log.llmOutput
        });
      }

      if (log.toolCall) {
        memory.push({
          role: MessageRole.ASSISTANT,
          content: JSON.stringify([{
            id: log.toolCall.id,
            type: "function",
            function: {
              name: log.toolCall.name,
              arguments: log.toolCall.arguments
            }
          }])
        });

        if (log.observations) {
          memory.push({
            role: MessageRole.TOOL_RESPONSE,
            content: `Call id: ${log.toolCall.id}\nObservation: ${log.observations}`
          });
        }

        if (log.error) {
          memory.push({
            role: MessageRole.TOOL_RESPONSE,
            content: `Call id: ${log.toolCall.id}\nError: ${log.error}\nNow let's retry: take care not to repeat previous errors! If you have retried several times, try a completely different approach.`
          });
        }
      }
    }

    return memory;
  }
}

export class CodeAgent extends MultiStepAgent {
  constructor({
    tools,
    model,
    systemPrompt = CODE_SYSTEM_PROMPT,
    grammar = null,
    additionalAuthorizedImports = null,
    planningInterval = null,
    ...rest
  }) {
    super({
      tools,
      model,
      systemPrompt,
      grammar,
      planningInterval,
      ...rest
    });

    this.additionalAuthorizedImports = additionalAuthorizedImports || [];

    const allTools = {
      ...this.toolbox.tools,
      ...this.managedAgents
    };

    this.javascriptExecutor = new LocalNodeInterpreter(
    this.additionalAuthorizedImports,
    allTools
    );

    this.authorizedImports = [
      ...new Set([...BASE_BUILTIN_MODULES, ...this.additionalAuthorizedImports])
    ];

    if (!this.systemPrompt.includes('{{authorized_imports}}')) {
      throw new Error("Tag '{{authorized_imports}}' should be provided in the prompt.");
    }

    this.systemPrompt = this.systemPrompt.replace(
      '{{authorized_imports}}',
      JSON.stringify(this.authorizedImports)
    );
  }

  async step(logEntry) {
    const agentMemory = this.writeInnerMemoryFromLogs();
    this.inputMessages = [...agentMemory];
    logEntry.agentMemory = [...agentMemory];

    try {
      const additionalArgs = this.grammar ? { grammar: this.grammar } : {};
      const llmOutput = await this.model(
        this.inputMessages,
        {
          stopSequences: ["<end_action>", "Observation:"],
          ...additionalArgs
        }
      );
      logEntry.llmOutput = llmOutput;

      if (this.verbose) {
        console.log('Output message of the LLM:', llmOutput);
      }

      const codeAction = parseCodeBlob(llmOutput);
      logEntry.toolCall = {
        name: "javascript_interpreter",
        arguments: codeAction,
        id: `call_${this.logs.length}`
      };

      console.log('Executing this code:', codeAction);

      let observation = '';
      try {
        const [output, executionLogs] = await this.javascriptExecutor(
          codeAction,
          this.state
        );

        if (executionLogs.length > 0) {
          console.log('Execution logs:', executionLogs);
          observation += `Execution logs:\n${executionLogs}`;
        }

        const truncatedOutput = truncateContent(String(output));
        observation += `Last output from code snippet:\n${truncatedOutput}`;
        logEntry.observations = observation;

        const isFinalAnswer = codeAction.split('\n').some(line => 
          line.trim().startsWith('final_answer')
        );

        console.log(`${isFinalAnswer ? 'Out - Final answer' : 'Out'}: ${truncatedOutput}`);
        logEntry.actionOutput = output;
        return isFinalAnswer ? output : null;

      } catch (e) {
        let errorMsg;
        if (e instanceof SyntaxError) {
          errorMsg = `Code execution failed on line ${e.lineNumber} due to: ${e.name}\n${e.message}\n${' '.repeat(e.columnNumber || 0)}^\nError: ${e.message}`;
        } else {
          errorMsg = `Code execution failed: ${e.message}`;
        }
        throw new AgentExecutionError(errorMsg);
      }

    } catch (e) {
      if (e instanceof AgentExecutionError) {
        throw e;
      }
      throw new AgentParsingError(`Error in code parsing: ${e}. Make sure to provide correct code`);
    }
  }
}

export class ManagedAgent {
  constructor({
    agent,
    name,
    description,
    additionalPrompting = null,
    provideRunSummary = false,
    managedAgentPrompt = MANAGED_AGENT_PROMPT
  }) {
    this.agent = agent;
    this.name = name;
    this.description = description;
    this.additionalPrompting = additionalPrompting;
    this.provideRunSummary = provideRunSummary;
    this.managedAgentPrompt = managedAgentPrompt;
  }

  writeFullTask(task) {
    let fullTask = this.managedAgentPrompt.replace('{name}', this.name).replace('{task}', task);
    if (this.additionalPrompting) {
      fullTask = fullTask.replace('\n{{additional_prompting}}', this.additionalPrompting);
    } else {
      fullTask = fullTask.replace('\n{{additional_prompting}}', '');
    }
    return fullTask.trim();
  }

  async __call__(request, kwargs = {}) {
    const fullTask = this.writeFullTask(request);
    const output = await this.agent.run(fullTask, kwargs);

    if (!this.provideRunSummary) {
      return output;
    }

    let answer = `Here is the final answer from your managed agent '${this.name}':\n${output}\n\n`;
    answer += `For more detail, find below a summary of this agent's work:\nSUMMARY OF WORK FROM AGENT '${this.name}':\n`;
    
    for (const message of this.agent.writeInnerMemoryFromLogs(true)) {
      const content = message.content;
      answer += `\n${truncateContent(String(content))}\n---`;
    }
    
    answer += `\nEND OF SUMMARY OF WORK FROM AGENT '${this.name}'.`;
    return answer;
  }
}
