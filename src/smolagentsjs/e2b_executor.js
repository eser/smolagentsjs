/**
 * @fileoverview E2B executor implementation for smolagentsjs
 * @license Apache-2.0
 */

import { Sandbox } from '@e2b/code-interpreter';
import { validateToolAttributes } from './tool_validation.js';
import { instanceToSource, BASE_BUILTIN_MODULES } from './utils.js';
import { Tool } from './tools.js';

/**
 * E2B executor for running code in a sandbox environment
 */
export class E2BExecutor {
  /**
   * @param {Array<string>} additionalImports - Additional imports to install
   * @param {Array<Tool>} tools - List of tools to make available
   */
  constructor(additionalImports, tools) {
    this.customTools = {};
    this.sbx = new Sandbox();

    // Add pickle5 to additional imports for Python compatibility
    const allImports = [...additionalImports, 'pickle5'];

    if (allImports.length > 0) {
      this.installDependencies(allImports);
    }

    const toolCodes = [];
    for (const tool of tools) {
      validateToolAttributes(tool.constructor, { checkImports: false });
      const toolCode = instanceToSource(tool, Tool);
      // Remove the import statement as we'll define Tool class inline
      const processedToolCode = toolCode.replace("from smolagents.tools import Tool", "");
      toolCodes.push(`${processedToolCode}\n${tool.name} = ${tool.constructor.name}()\n`);
    }

    // Create the tool definition code
    let toolDefinitionCode = BASE_BUILTIN_MODULES.map(module => 
      `import ${module}`
    ).join('\n');

    toolDefinitionCode += `
class Tool:
    def __call__(self, *args, **kwargs):
        return self.forward(*args, **kwargs)

    def forward(self, *args, **kwargs):
        pass # to be implemented in child class
`;

    toolDefinitionCode += toolCodes.join('\n\n');

    const toolDefinitionExecution = this.runCodeRaiseErrors(toolDefinitionCode);
    console.log(toolDefinitionExecution.logs);
  }

  /**
   * Install Python dependencies in the sandbox
   * @param {Array<string>} dependencies - List of dependencies to install
   * @private
   */
  async installDependencies(dependencies) {
    const execution = await this.sbx.commands.run(
      `pip install ${dependencies.join(' ')}`
    );

    if (execution.error) {
      throw new Error(`Error installing dependencies: ${execution.error}`);
    }
    console.log(`Installation of ${dependencies} succeeded!`);
  }

  /**
   * Run code and raise any errors that occur
   * @param {string} code - Code to execute
   * @private
   */
  async runCodeRaiseErrors(code) {
    const execution = await this.sbx.runCode(code);
    
    if (execution.error) {
      const executionLogs = execution.logs.stdout.join('\n');
      let logs = executionLogs;
      logs += 'Executing code yielded an error:';
      logs += execution.error.name;
      logs += execution.error.value;
      logs += execution.error.traceback;
      throw new Error(logs);
    }
    return execution;
  }

  /**
   * Execute code with additional arguments
   * @param {string} codeAction - Code to execute
   * @param {Object} additionalArgs - Additional arguments to pass to the code
   * @returns {Promise<Array>} Tuple of [result, executionLogs]
   */
  async __call__(codeAction, additionalArgs) {
    if (Object.keys(additionalArgs).length > 0) {
      // Create a temporary file with pickled data
      const pickle = require('pickle');
      const fs = require('node:fs').promises;
      const os = require('node:os');
      const path = require('node:path');

      const tempFile = path.join(os.tmpdir(), 'state.pkl');
      const serializedData = pickle.dumps(additionalArgs);
      await fs.writeFile(tempFile, serializedData);

      // Upload the file to the sandbox
      await this.sbx.files.write('/home/state.pkl', await fs.readFile(tempFile));

      // Load the pickled data in the remote environment
      const remoteUnloadingCode = `
import pickle
import os
print("File path", os.path.getsize('/home/state.pkl'))
with open('/home/state.pkl', 'rb') as f:
    pickle_dict = pickle.load(f)
locals().update({key: value for key, value in pickle_dict.items()})
`;
      const execution = await this.runCodeRaiseErrors(remoteUnloadingCode);
      const executionLogs = execution.logs.stdout.join('\n');
      console.log(executionLogs);

      // Clean up temp file
      await fs.unlink(tempFile);
    }

    const execution = await this.runCodeRaiseErrors(codeAction);
    const executionLogs = execution.logs.stdout.join('\n');

    if (!execution.results) {
      return [null, executionLogs];
    }

    for (const result of execution.results) {
      if (result.isMainResult) {
        // Handle image outputs
        for (const attribute of ['jpeg', 'png']) {
          if (result[attribute]) {
            const imageOutput = result[attribute];
            const decodedBytes = Buffer.from(imageOutput, 'base64');
            const sharp = require('sharp');
            return [await sharp(decodedBytes).toBuffer(), executionLogs];
          }
        }

        // Handle other output types
        const outputTypes = [
          'chart',
          'data',
          'html',
          'javascript',
          'json',
          'latex',
          'markdown',
          'pdf',
          'svg',
          'text'
        ];

        for (const attribute of outputTypes) {
          if (result[attribute]) {
            return [result[attribute], executionLogs];
          }
        }
      }
    }

    throw new Error('No main result returned by executor!');
  }
}
