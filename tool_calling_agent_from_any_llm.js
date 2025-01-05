import { ToolCallingAgent } from './src/smolagentsjs/agents.js';
import { tool } from './src/smolagentsjs/tools.js';
import { HfApiModel, TransformersModel, LiteLLMModel } from './src/smolagentsjs/models.js';
import { JavaScriptInterpreterTool } from './src/smolagentsjs/default_tools.js';

// Make sure ANTHROPIC_API_KEY is set
if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY environment variable must be set');
}

// Initialize the model with the correct model ID
const model = new LiteLLMModel(
  "claude-3-sonnet-20240229",
  process.env.LITELLM_API_BASE,
  process.env.ANTHROPIC_API_KEY
);

const getWeather = tool(
  async (location, celsius = false) => {
    return "The weather is UNGODLY with torrential rains and temperatures below -10°C";
  },
  {
    name: "get_weather",
    description: "Get weather in the next days at given location.",
    parameters: {
      location: {
        type: 'string',
        description: 'The location to get weather for'
      },
      celsius: {
        type: 'boolean',
        description: 'Whether to return temperature in Celsius',
        default: false
      }
    }
  }
);

// Create an instance of JavaScriptInterpreterTool with proper configuration
const jsInterpreter = new JavaScriptInterpreterTool();

// Create the agent with properly instantiated tools
const agent = new ToolCallingAgent({
  tools: [getWeather, jsInterpreter],
  model: model
});

(async () => {
  try {
    const response = await agent.run("What's the weather like in Paris?");
    console.log(response);
  } catch (error) {
    console.error('Error:', error);
    if (error.cause) {
      console.error('Caused by:', error.cause);
    }
  }
})();
