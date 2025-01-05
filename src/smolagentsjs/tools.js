/**
 * @fileoverview Core tools implementation for smolagentsjs
 * @license Apache-2.0
 */

// Type definitions
/**
 * @typedef {Object} ToolInput
 * @property {string} type - The input type (string, boolean, integer, number, image, audio, any, object)
 * @property {string} description - Description of what the input does
 * @property {boolean} [nullable] - Whether the input is optional
 */

/**
 * @typedef {Object.<string, ToolInput>} ToolInputs
 */

const AUTHORIZED_TYPES = [
  "string",
  "boolean", 
  "integer",
  "number",
  "image",
  "audio",
  "any",
  "object"
];

/**
 * Base Tool class that all tools should extend
 */
class Tool {
  /**
   * @param {Object} config
   * @param {string} config.name - Tool name
   * @param {string} config.description - Tool description
   * @param {ToolInputs} config.inputs - Tool input parameters
   * @param {string} config.outputType - Tool output type
   */
  constructor(config = {}) {
    this.name = config.name;
    this.description = config.description;
    this.inputs = config.inputs || {};
    this.outputType = config.outputType;
    this.isInitialized = false;
    this.validateArguments();
  }

  /**
   * Validates the tool configuration
   * @throws {Error} If validation fails
   */
  validateArguments() {
    if (!this.name || typeof this.name !== 'string') {
      throw new TypeError('Tool must have a name string');
    }
    if (!this.description || typeof this.description !== 'string') {
      throw new TypeError('Tool must have a description string'); 
    }
    if (!this.inputs || typeof this.inputs !== 'object') {
      throw new TypeError('Tool must have an inputs object');
    }
    if (!this.outputType || typeof this.outputType !== 'string') {
      throw new TypeError('Tool must have an outputType string');
    }

    // Validate inputs
    for (const [inputName, input] of Object.entries(this.inputs)) {
      if (!input.type || !input.description) {
        throw new TypeError(`Input ${inputName} must have type and description`);
      }
      if (!AUTHORIZED_TYPES.includes(input.type)) {
        throw new TypeError(`Input ${inputName} has invalid type ${input.type}`);
      }
    }

    // Validate output type
    if (!AUTHORIZED_TYPES.includes(this.outputType)) {
      throw new TypeError(`Invalid output type: ${this.outputType}`);
    }
  }

  /**
   * Initialize any resources needed by the tool
   * Override this in subclasses if needed
   */
  async setup() {
    this.isInitialized = true;
  }

  /**
   * Execute the tool with given inputs
   * @param {...any} args - Tool arguments
   * @returns {Promise<any>} Tool execution result
   */
  async forward(...args) {
    throw new Error('Tool must implement forward() method');
  }

  /**
   * Call the tool with arguments
   * @param {...any} args - Tool arguments
   * @returns {Promise<any>} Tool execution result
   */
  async __call__(...args) {
    if (!this.isInitialized) {
      await this.setup();
    }
    return this.forward(...args);
  }
}

/**
 * Tool decorator factory
 * @param {Object} config - Tool configuration
 * @returns {Function} Decorator function
 */
function tool(config) {
  return target => class extends Tool {
    constructor() {
      super({
        name: config.name,
        description: config.description,
        inputs: config.inputs,
        outputType: config.outputType
      });
      this.forward = target.prototype.forward;
    }
  }
}

/**
 * Collection of tools
 */
class Toolbox {
  /**
   * @param {Tool[]} tools - List of tools
   * @param {boolean} addBaseTools - Whether to add default tools
   */
  constructor(tools = [], addBaseTools = false) {
    this._tools = new Map();
    for (const tool of tools) {
      this.addTool(tool);
    }
    
    if (addBaseTools) {
      this.addBaseTools();
    }
  }

  /**
   * Add default tools
   */
  addBaseTools() {
    // TODO: Implement default tools
  }

  /**
   * Get all tools
   * @returns {Map<string,Tool>} Map of tool name to tool instance
   */
  get tools() {
    return this._tools;
  }

  /**
   * Add a tool
   * @param {Tool} tool Tool instance to add
   */
  addTool(tool) {
    if (this._tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} already exists`);
    }
    this._tools.set(tool.name, tool);
  }

  /**
   * Remove a tool
   * @param {string} toolName Name of tool to remove
   */
  removeTool(toolName) {
    if (!this._tools.has(toolName)) {
      throw new Error(`Tool ${toolName} not found`);
    }
    this._tools.delete(toolName);
  }

  /**
   * Update an existing tool
   * @param {Tool} tool Tool instance to update
   */
  updateTool(tool) {
    if (!this._tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} not found`);
    }
    this._tools.set(tool.name, tool);
  }

  /**
   * Clear all tools
   */
  clearToolbox() {
    this._tools.clear();
  }

  /**
   * Get tool descriptions
   * @returns {string} Formatted tool descriptions
   */
  showToolDescriptions() {
    let desc = 'Toolbox contents:\n';
    for (const [name, tool] of this._tools) {
      desc += `\t${name}: ${tool.description}\n`;
    }
    return desc;
  }
}

export {
  Tool,
  tool,
  Toolbox,
  AUTHORIZED_TYPES
}; 
