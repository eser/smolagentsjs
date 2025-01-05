/**
 * @fileoverview Local Node.js code executor implementation for smolagentsjs
 * @license Apache-2.0
 */

import vm from 'node:vm';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { truncateContent } from './utils.js';

// Constants
const MAX_LEN_OUTPUT = 50000;
const MAX_OPERATIONS = 10000000;

// Base built-in modules that are safe to use
export const BASE_BUILTIN_MODULES = [
  'assert',
  'buffer',
  'events',
  'path',
  'querystring',
  'stream',
  'string_decoder',
  'timers',
  'url',
  'util'
];

// Base JavaScript tools (equivalent to Python's BASE_PYTHON_TOOLS)
export const BASE_JS_TOOLS = {
  // Type conversion
  Number,
  String,
  Boolean,
  Array,
  Object,
  Set,
  Map,
  
  // Math functions
  Math,
  
  // Array/Collection operations
  isArray: Array.isArray,
  from: Array.from,
  
  // Object operations
  keys: Object.keys,
  values: Object.values,
  entries: Object.entries,
  assign: Object.assign,
  
  // String operations
  toLowerCase: (s) => String(s).toLowerCase(),
  toUpperCase: (s) => String(s).toUpperCase(),
  trim: (s) => String(s).trim(),
  
  // Type checking
  typeof: (x) => typeof x,
  instanceof: (obj, type) => obj instanceof type,
  
  // Utility functions
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  
  // JSON operations
  JSON: {
    parse: JSON.parse,
    stringify: JSON.stringify
  }
};

/**
 * Custom error for interpreter-related issues
 */
export class InterpreterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InterpreterError';
  }
}

/**
 * Captures console output during code execution
 */
class OutputCapturer {
  constructor() {
    this.output = '';
    this.stream = new Writable({
      write: (chunk, encoding, callback) => {
        this.output += chunk.toString();
        callback();
      }
    });
    this.console = new Console(this.stream);
  }

  getOutput() {
    return this.output;
  }

  clear() {
    this.output = '';
  }
}

/**
 * Evaluates JavaScript code in a sandboxed environment
 * @param {string} code - Code to evaluate
 * @param {Object} context - Variables and functions available to the code
 * @param {Object} options - Additional options for code execution
 * @returns {*} Result of the code execution
 */
export function evaluateCode(code, context = {}, options = {}) {
  const outputCapturer = new OutputCapturer();
  
  // Create a secure context with limited access to globals
  const sandbox = {
    console: outputCapturer.console,
    require: createSecureRequire(options.authorizedImports || BASE_BUILTIN_MODULES),
    ...BASE_JS_TOOLS,
    ...context
  };

  // Create VM context
  const vmContext = vm.createContext(sandbox);

  try {
    // Add operation counter to prevent infinite loops
    const script = new vm.Script(
      `const __operationsCount = 0;
      ${code}`,
      { 
        filename: 'usercode.js',
        lineOffset: 0,
        columnOffset: 0,
        timeout: 5000 // 5 second timeout
      }
    );

    // Run the code
    const result = script.runInContext(vmContext);
    
    // Store console output in state if provided
    if (context.state) {
      context.state.printOutputs = truncateContent(
        outputCapturer.getOutput(),
        MAX_LEN_OUTPUT
      );
    }

    return result;
  } catch (error) {
    if (error instanceof InterpreterError) {
      throw error;
    }
    
    const errorMsg = `Code execution failed: ${error.message}
    at line ${error.lineNumber || 'unknown'}
    ${error.stack || ''}`;
    throw new InterpreterError(errorMsg);
  }
}

/**
 * Creates a secure require function that only allows specific modules
 * @param {Array<string>} authorizedModules - List of modules that can be required
 * @returns {Function} Secure require function
 */
function createSecureRequire(authorizedModules) {
  return function secureRequire(moduleName) {
    if (!authorizedModules.includes(moduleName)) {
      throw new InterpreterError(
        `Module '${moduleName}' is not authorized. Allowed modules are: ${authorizedModules.join(', ')}`
      );
    }
    return require(moduleName);
  };
}

/**
 * Local Node.js code interpreter
 */
export class LocalNodeInterpreter {
  /**
   * @param {Array<string>} additionalAuthorizedImports - Additional modules to allow
   * @param {Object} tools - Tools to make available to the code
   */
  constructor(additionalAuthorizedImports = [], tools = {}) {
    this.customTools = {};
    this.state = {};
    this.additionalAuthorizedImports = additionalAuthorizedImports;
    this.authorizedImports = [
      ...new Set([...BASE_BUILTIN_MODULES, ...additionalAuthorizedImports])
    ];
    
    // Add base trusted tools and provided tools
    this.staticTools = {
      ...tools,
      ...BASE_JS_TOOLS
    };
  }

  /**
   * Execute code with additional variables
   * @param {string} codeAction - Code to execute
   * @param {Object} additionalVariables - Additional variables to make available
   * @returns {Promise<Array>} Tuple of [result, logs]
   */
  async __call__(codeAction, additionalVariables = {}) {
    this.state = { ...this.state, ...additionalVariables };
    
    try {
      const output = evaluateCode(
        codeAction,
        {
          state: this.state,
          ...this.staticTools,
          ...this.customTools
        },
        {
          authorizedImports: this.authorizedImports
        }
      );

      const logs = this.state.printOutputs || '';
      return [output, logs];
    } catch (error) {
      if (error instanceof InterpreterError) {
        throw error;
      }
      throw new InterpreterError(`Execution failed: ${error.message}`);
    }
  }
}
