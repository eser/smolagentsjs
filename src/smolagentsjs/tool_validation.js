import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { BASE_BUILTIN_MODULES } from './utils.js';

// JavaScript built-in globals
export const BUILTIN_NAMES = new Set([
  'Object', 'Function', 'Array', 'Number', 'String', 'Boolean', 'Symbol',
  'Date', 'RegExp', 'Error', 'Math', 'JSON', 'console', 'undefined',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
  'encodeURIComponent', 'decodeURIComponent', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Proxy', 'Reflect', 'BigInt', 'Intl'
]);

export class MethodChecker {
  constructor(classAttributes, checkImports = true) {
    this.undefinedNames = new Set();
    this.imports = new Map();
    this.fromImports = new Map();
    this.assignedNames = new Set();
    this.argNames = new Set();
    this.classAttributes = classAttributes;
    this.errors = [];
    this.checkImports = checkImports;
  }

  visitParams(node) {
    for (const param of node.params) {
      if (param.type === 'Identifier') {
        this.argNames.add(param.name);
      } else if (param.type === 'RestElement') {
        this.argNames.add(param.argument.name);
      }
    }
  }

  visitVariableDeclaration(node) {
    for (const decl of node.declarations) {
      if (decl.id.type === 'Identifier') {
        this.assignedNames.add(decl.id.name);
      }
    }
  }

  visitIdentifier(node) {
    const name = node.name;
    if (!this.isDefinedName(name)) {
      this.errors.push(`Name '${name}' is undefined.`);
    }
  }

  isDefinedName(name) {
    return (
      BUILTIN_NAMES.has(name) ||
      BASE_BUILTIN_MODULES.includes(name) ||
      this.argNames.has(name) ||
      name === 'this' ||
      this.classAttributes.has(name) ||
      this.imports.has(name) ||
      this.fromImports.has(name) ||
      this.assignedNames.has(name)
    );
  }
}

export function validateToolAttributes(cls, checkImports = true) {
  const errors = [];

  // Get class source code
  const source = cls.toString();
  
  try {
    // Parse the class definition
    const ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module'
    });

    // Check that it's a class definition
    if (ast.body[0].type !== 'ClassDeclaration') {
      throw new Error('Source code must define a class');
    }

    // Check constructor parameters
    const ctor = cls.prototype.constructor;
    if (ctor !== Object && ctor.length > 1) {
      errors.push(
        `This tool has additional args specified in constructor: ${ctor.length - 1}. Make sure it does not, all values should be hardcoded!`
      );
    }

    // Track class-level information
    const classAttributes = new Set();
    const complexAttributes = new Set();

    // Visit class body
    walk.simple(ast.body[0], {
      PropertyDefinition(node) {
        if (node.static && node.key.type === 'Identifier') {
          classAttributes.add(node.key.name);
          
          // Check for complex initializers
          if (node.value && !isSimpleLiteral(node.value)) {
            complexAttributes.add(node.key.name);
          }
        }
      },
      
      MethodDefinition(node) {
        if (node.kind === 'method') {
          const methodChecker = new MethodChecker(classAttributes, checkImports);
          methodChecker.visitParams(node.value);
          
          walk.simple(node.value, {
            Identifier: (n) => methodChecker.visitIdentifier(n),
            VariableDeclaration: (n) => methodChecker.visitVariableDeclaration(n)
          });

          errors.push(...methodChecker.errors.map(err => `- ${node.key.name}: ${err}`));
        }
      }
    });

    if (complexAttributes.size > 0) {
      errors.push(
        `Complex attributes should be defined in constructor, not as class attributes: ${Array.from(complexAttributes).join(', ')}`
      );
    }

  } catch (error) {
    errors.push(`Failed to parse class: ${error.message}`);
  }

  if (errors.length > 0) {
    throw new Error(`Tool validation failed:\n${errors.join('\n')}`);
  }
}

function isSimpleLiteral(node) {
  return (
    node.type === 'Literal' ||
    (node.type === 'ArrayExpression' && node.elements.every(isSimpleLiteral)) ||
    (node.type === 'ObjectExpression' && node.properties.every(p => isSimpleLiteral(p.value)))
  );
}
