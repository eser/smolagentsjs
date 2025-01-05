export const AUTHORIZED_TYPES = [
  "string",
  "boolean", 
  "integer",
  "number",
  "image",
  "audio",
  "any",
  "object"
];

export class Tool {
  constructor(config = {}) {
    this.name = config.name;
    this.description = config.description;
    this.inputs = config.inputs || {};
    this.outputType = config.outputType;
    this.isInitialized = false;
    this.validateArguments();
  }

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

  async setup() {
    this.isInitialized = true;
  }

  async forward(...args) {
    throw new Error('Tool must implement forward() method');
  }

  async __call__(...args) {
    if (!this.isInitialized) {
      await this.setup();
    }
    return this.forward(...args);
  }
}

export function tool(config) {
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

export class Toolbox {
  constructor(tools = [], addBaseTools = false) {
    this._tools = new Map();
    for (const tool of tools) {
      this.addTool(tool);
    }
    
    if (addBaseTools) {
      this.addBaseTools();
    }
  }

  addBaseTools() {
    // TODO: Implement default tools
  }

  get tools() {
    return this._tools;
  }

  addTool(tool) {
    if (this._tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} already exists`);
    }
    this._tools.set(tool.name, tool);
  }

  removeTool(toolName) {
    if (!this._tools.has(toolName)) {
      throw new Error(`Tool ${toolName} not found`);
    }
    this._tools.delete(toolName);
  }

  updateTool(tool) {
    if (!this._tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} not found`);
    }
    this._tools.set(tool.name, tool);
  }

  clearToolbox() {
    this._tools.clear();
  }

  showToolDescriptions() {
    let desc = 'Toolbox contents:\n';
    for (const [name, tool] of this._tools) {
      desc += `\t${name}: ${tool.description}\n`;
    }
    return desc;
  }
}
