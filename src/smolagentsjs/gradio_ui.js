/**
 * @fileoverview Gradio UI implementation for smolagentsjs
 * @license Apache-2.0
 */

const { AgentAudio, AgentImage, AgentText, handleAgentOutputTypes } = require('./types');
const { MultiStepAgent, AgentStep, ActionStep } = require('./agents');
const gradio = require('@gradio/client');

/**
 * Extract ChatMessage objects from agent steps
 * @param {AgentStep} stepLog - The step log to extract messages from
 * @param {boolean} testMode - Whether in test mode
 * @yields {Object} Gradio chat message
 */
function* pullMessagesFromStep(stepLog, testMode = true) {
  if (stepLog instanceof ActionStep) {
    yield {
      role: 'assistant',
      content: stepLog.llmOutput
    };

    if (stepLog.toolCall !== null) {
      const usedCode = stepLog.toolCall.name === 'code interpreter';
      let content = stepLog.toolCall.arguments;
      if (usedCode) {
        content = `\`\`\`js\n${content}\n\`\`\``;
      }
      yield {
        role: 'assistant',
        metadata: { title: `🛠️ Used tool ${stepLog.toolCall.name}` },
        content: String(content)
      };
    }

    if (stepLog.observations !== null) {
      yield {
        role: 'assistant',
        content: `\`\`\`\n${stepLog.observations}\n\`\`\``
      };
    }

    if (stepLog.error !== null) {
      yield {
        role: 'assistant',
        content: String(stepLog.error),
        metadata: { title: '💥 Error' }
      };
    }
  }
}

/**
 * Stream agent output to Gradio
 * @param {MultiStepAgent} agent - The agent to run
 * @param {string} task - The task to run
 * @param {boolean} testMode - Whether in test mode
 * @param {boolean} resetAgentMemory - Whether to reset agent memory
 * @param {Object} kwargs - Additional arguments
 * @yields {Object} Gradio chat message
 */
export async function* streamToGradio(agent, task, testMode = false, resetAgentMemory = false, kwargs = {}) {
  let stepLog;
  for await (stepLog of agent.run(task, { stream: true, reset: resetAgentMemory, ...kwargs })) {
    for (const message of pullMessagesFromStep(stepLog, testMode)) {
      yield message;
    }
  }

  // Last log is the run's final_answer
  const finalAnswer = handleAgentOutputTypes(stepLog);

  if (finalAnswer instanceof AgentText) {
    yield {
      role: 'assistant',
      content: `**Final answer:**\n\`\`\`\n${finalAnswer.toString()}\n\`\`\``
    };
  } else if (finalAnswer instanceof AgentImage) {
    yield {
      role: 'assistant',
      content: {
        path: finalAnswer.toString(),
        mimeType: 'image/png'
      }
    };
  } else if (finalAnswer instanceof AgentAudio) {
    yield {
      role: 'assistant',
      content: {
        path: finalAnswer.toString(),
        mimeType: 'audio/wav'
      }
    };
  } else {
    yield {
      role: 'assistant',
      content: String(finalAnswer)
    };
  }
}

/**
 * A one-line interface to launch your agent in Gradio
 */
export class GradioUI {
  /**
   * @param {MultiStepAgent} agent - The agent to use
   */
  constructor(agent) {
    this.agent = agent;
  }

  /**
   * Interact with the agent
   * @param {string} prompt - The prompt to send
   * @param {Array} messages - The message history
   * @yields {Array} Updated message history
   */
  async* interactWithAgent(prompt, messages) {
    messages.push({
      role: 'user',
      content: prompt
    });
    yield messages;

    for await (const msg of streamToGradio(this.agent, prompt, false)) {
      messages.push(msg);
      yield messages;
    }
    yield messages;
  }

  /**
   * Launch the Gradio interface
   */
  async launch() {
    const app = gradio.Blocks();

    await app.load(demo => {
      const storedMessage = demo.State([]);
      const chatbot = demo.Chatbot({
        label: 'Agent',
        type: 'messages',
        avatarImages: [
          null,
          'https://em-content.zobj.net/source/twitter/53/robot-face_1f916.png'
        ]
      });
      const textInput = demo.Textbox({
        lines: 1,
        label: 'Chat Message'
      });

      textInput.submit(
        (s) => [s, ''],
        [textInput],
        [storedMessage, textInput]
      ).then(
        this.interactWithAgent,
        [storedMessage, chatbot],
        [chatbot]
      );
    });

    await app.launch();
  }
}
