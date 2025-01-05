/**
 * @license
 * Copyright 2024 The HuggingFace Inc. team. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Export constants
export const BASE_BUILTIN_MODULES = [
  'collections',
  'datetime',
  'itertools',
  'math',
  'queue',
  'random',
  're',
  'stat',
  'statistics',
  'time',
  'unicodedata',
];

export const MAX_LENGTH_TRUNCATE_CONTENT = 20000;

// Export error classes
export class AgentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentError';
    this.message = message;
    console.error(`\x1b[31m${message}\x1b[0m`); // Bold red console output
  }
}

export class AgentParsingError extends AgentError {
  constructor(message) {
    super(message);
    this.name = 'AgentParsingError';
  }
}

export class AgentExecutionError extends AgentError {
  constructor(message) {
    super(message);
    this.name = 'AgentExecutionError';
  }
}

export class AgentMaxIterationsError extends AgentError {
  constructor(message) {
    super(message);
    this.name = 'AgentMaxIterationsError';
  }
}

export class AgentGenerationError extends AgentError {
  constructor(message) {
    super(message);
    this.name = 'AgentGenerationError';
  }
}

// Export functions
export function parseJsonBlob(jsonBlob) {
  try {
    const firstAccoladeIndex = jsonBlob.indexOf('{');
    const lastAccoladeIndex = jsonBlob.lastIndexOf('}');
    const cleanedJson = jsonBlob
      .slice(firstAccoladeIndex, lastAccoladeIndex + 1)
      .replace(/\\"/g, "'");
    return JSON.parse(cleanedJson);
  } catch (e) {
    if (e instanceof SyntaxError) {
      const errorPosition = e.message.match(/position (\d+)/)?.[1];
      if (errorPosition && jsonBlob.slice(errorPosition - 1, errorPosition + 2) === '},\n') {
        throw new Error('JSON is invalid: you probably tried to provide multiple tool calls in one action. PROVIDE ONLY ONE TOOL CALL.');
      }
      throw new Error(`The JSON blob you used is invalid due to the following error: ${e.message}`);
    }
    throw new Error(`Error in parsing the JSON blob: ${e.message}`);
  }
}

export function parseCodeBlob(codeBlob) {
  try {
    const pattern = /```(?:js|javascript)?\n(.*?)\n```/s;
    const match = codeBlob.match(pattern);
    if (!match) {
      throw new Error(`No match found for regex pattern ${pattern} in code blob.`);
    }
    return match[1].trim();
  } catch (e) {
    throw new Error(
      `The code blob you used is invalid due to the following error: ${e.message}\nThis means that the regex pattern ${pattern} was not respected: make sure to include code with the correct pattern.`
    );
  }
}

export function parseJsonToolCall(jsonBlob) {
  const cleanedJson = jsonBlob.replace(/```json/g, '').replace(/```/g, '');
  const toolCall = parseJsonBlob(cleanedJson);
  
  const toolNameKeys = ['action', 'tool_name', 'tool', 'name', 'function'];
  const toolArgsKeys = ['action_input', 'tool_arguments', 'tool_args', 'parameters'];
  
  let toolName = null;
  let toolArgs = null;
  
  for (const key of toolNameKeys) {
    if (key in toolCall) {
      toolName = toolCall[key];
      break;
    }
  }
  
  for (const key of toolArgsKeys) {
    if (key in toolCall) {
      toolArgs = toolCall[key];
      break;
    }
  }
  
  if (!toolName) {
    throw new AgentParsingError(`No tool name key found in tool call! Tool call: ${jsonBlob}`);
  }
  
  return [toolName, toolArgs];
}

export function truncateContent(content, maxLength = MAX_LENGTH_TRUNCATE_CONTENT) {
  if (content.length <= maxLength) {
    return content;
  }
  
  const halfLength = Math.floor(maxLength / 2);
  return (
    content.slice(0, halfLength) +
    `\n..._This content has been truncated to stay below ${maxLength} characters_...\n` +
    content.slice(-halfLength)
  );
}

export function getMethodSource(method) {
  return method.toString().trim();
}

export function isSameMethod(method1, method2) {
  try {
    const source1 = getMethodSource(method1);
    const source2 = getMethodSource(method2);
    
    // Remove decorators if any
    const cleanSource1 = source1.split('\n')
      .filter(line => !line.trim().startsWith('@'))
      .join('\n');
    const cleanSource2 = source2.split('\n')
      .filter(line => !line.trim().startsWith('@'))
      .join('\n');
    
    return cleanSource1 === cleanSource2;
  } catch (e) {
    return false;
  }
}

export function isSameItem(item1, item2) {
  if (typeof item1 === 'function' && typeof item2 === 'function') {
    return isSameMethod(item1, item2);
  }
  return item1 === item2;
}

export function instanceToSource(instance, baseClass = null) {
  const cls = Object.getPrototypeOf(instance).constructor;
  const className = cls.name;
  const classLines = [];

  // Start class definition
  if (baseClass) {
    classLines.push(`class ${className} extends ${baseClass.name} {`);
  } else {
    classLines.push(`class ${className} {`);
  }

  // Add constructor if it exists and differs from base
  const constructor = Object.getOwnPropertyDescriptor(cls.prototype, 'constructor')?.value;
  if (constructor && (!baseClass || constructor !== baseClass.prototype.constructor)) {
    const constructorSource = constructor.toString()
      .replace(`class ${className}`, '') // Remove class wrapper if present
      .replace(/^function\s*\(\)/, 'constructor()') // Replace function with constructor
      .split('\n')
      .map(line => '  ' + line) // Indent lines
      .join('\n');
    classLines.push(constructorSource);
  }

  // Add class-level properties and methods
  const prototype = cls.prototype;
  const properties = Object.getOwnPropertyNames(prototype)
    .filter(name => name !== 'constructor')
    .filter(name => {
      if (!baseClass) return true;
      return !baseClass.prototype[name] || 
             !isSameMethod(prototype[name], baseClass.prototype[name]);
    });

  // Add instance properties (from constructor)
  const instanceProps = Object.getOwnPropertyNames(instance)
    .filter(name => {
      if (!baseClass) return true;
      const baseInstance = Object.create(baseClass.prototype);
      return !baseInstance.hasOwnProperty(name) || 
             !isSameItem(instance[name], baseInstance[name]);
    });

  // Add methods
  for (const prop of properties) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, prop);
    if (typeof descriptor.value === 'function') {
      const methodSource = descriptor.value.toString()
        .replace('function ', '') // Remove 'function' keyword
        .split('\n')
        .map(line => '  ' + line) // Indent lines
        .join('\n');
      classLines.push(methodSource);
    } else if (descriptor.get || descriptor.set) {
      // Handle getters/setters
      if (descriptor.get) {
        const getterSource = descriptor.get.toString()
          .replace('function ', 'get ')
          .split('\n')
          .map(line => '  ' + line)
          .join('\n');
        classLines.push(getterSource);
      }
      if (descriptor.set) {
        const setterSource = descriptor.set.toString()
          .replace('function ', 'set ')
          .split('\n')
          .map(line => '  ' + line)
          .join('\n');
        classLines.push(setterSource);
      }
    }
  }

  // Add static properties and methods
  const staticProps = Object.getOwnPropertyNames(cls)
    .filter(name => !['length', 'prototype', 'name'].includes(name))
    .filter(name => {
      if (!baseClass) return true;
      return !baseClass[name] || !isSameItem(cls[name], baseClass[name]);
    });

  for (const prop of staticProps) {
    const descriptor = Object.getOwnPropertyDescriptor(cls, prop);
    if (typeof descriptor.value === 'function') {
      const methodSource = descriptor.value.toString()
        .replace('function ', 'static ')
        .split('\n')
        .map(line => '  ' + line)
        .join('\n');
      classLines.push(methodSource);
    } else {
      // Static properties
      classLines.push(`  static ${prop} = ${JSON.stringify(cls[prop])};`);
    }
  }

  classLines.push('}'); // Close class definition

  return classLines.join('\n');
}
