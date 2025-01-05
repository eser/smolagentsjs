import { ToolCallingAgent } from './src/smolagentsjs/agents.js';
import { tool } from './src/smolagentsjs/tools.js';
import { HfApiModel, TransformersModel, LiteLLMModel } from './src/smolagentsjs/models.js';
import { JavaScriptInterpreterTool } from './src/smolagentsjs/default_tools.js';

if (!process.env.PLATFORM_API_KEY) {
  throw new Error('PLATFORM_API_KEY environment variable must be set');
}

const model = new LiteLLMModel(
  "gpt-4o-mini",
  process.env.LITELLM_API_BASE,
  process.env.PLATFORM_API_KEY
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

const jsInterpreter = new JavaScriptInterpreterTool();

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
