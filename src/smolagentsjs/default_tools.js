import { createInterface } from 'node:readline';
import { Tool } from './tools.js';
import { LocalNodeInterpreter } from './local_nodejs_executor.js';

export class JavaScriptInterpreterTool extends Tool {
  constructor() {
    super({
      name: 'javascript_interpreter',
      description: 'This is a tool that evaluates JavaScript code. It can be used to perform calculations.',
      inputs: {
        code: {
          type: 'string',
          description: 'The JavaScript code to run in interpreter'
        }
      },
      outputType: 'string'
    });
    
    this.interpreter = new LocalNodeInterpreter();
  }

  async __call__(args) {
    const code = args.code;
    const [output, logs] = await this.interpreter(code);
    if (logs && logs.length > 0) {
      return `Logs:\n${logs.join('\n')}\nOutput: ${output}`;
    }
    return String(output);
  }
}

export class FinalAnswerTool extends Tool {
  static name = 'final_answer';
  static description = 'Provides a final answer to the given problem.';
  static inputs = {
    answer: {
      type: 'any',
      description: 'The final answer to the problem'
    }
  };
  static outputType = 'any';

  async forward(answer) {
    return answer;
  }
}

export class UserInputTool extends Tool {
  static name = 'user_input';
  static description = "Asks for user's input on a specific question";
  static inputs = {
    question: {
      type: 'string',
      description: 'The question to ask the user'
    }
  };
  static outputType = 'string';

  async forward(question) {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise(resolve => {
      readline.question(`${question} => `, answer => {
        readline.close();
        resolve(answer);
      });
    });
  }
}

export class DuckDuckGoSearchTool extends Tool {
  static name = 'web_search';
  static description = `Performs a duckduckgo web search based on your query (think a Google search) then returns the top search results as a list of dict elements.
Each result has keys 'title', 'href' and 'body'.`;
  static inputs = {
    query: {
      type: 'string',
      description: 'The search query to perform.'
    }
  };
  static outputType = 'any';

  constructor() {
    super();
    try {
      this.ddgs = require('duckduckgo-search');
    } catch (e) {
      throw new Error(
        'You must install package `duckduckgo-search` to run this tool: run `npm install duckduckgo-search`.'
      );
    }
  }

  async forward(query) {
    const results = await this.ddgs.search(query, { max_results: 10 });
    const postprocessedResults = results.map(result => 
      `[${result.title}](${result.href})\n${result.body}`
    );
    return `## Search Results\n\n${postprocessedResults.join('\n\n')}`;
  }
}

export class GoogleSearchTool extends Tool {
  static name = 'web_search';
  static description = 'Performs a google web search for your query then returns a string of the top search results.';
  static inputs = {
    query: {
      type: 'string',
      description: 'The search query to perform.'
    },
    filterYear: {
      type: 'integer',
      description: 'Optionally restrict results to a certain year',
      nullable: true
    }
  };
  static outputType = 'string';

  constructor() {
    super();
    this.serpapiKey = process.env.SERPAPI_API_KEY;
  }

  async forward(query, filterYear = null) {
    if (!this.serpapiKey) {
      throw new Error('Missing SerpAPI key. Make sure you have "SERPAPI_API_KEY" in your env variables.');
    }

    const params = new URLSearchParams({
      engine: 'google',
      q: query,
      api_key: this.serpapiKey,
      google_domain: 'google.com'
    });

    if (filterYear) {
      params.append('tbs', `cdr:1,cd_min:01/01/${filterYear},cd_max:12/31/${filterYear}`);
    }

    try {
      const response = await fetch(`https://serpapi.com/search.json?${params}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const results = await response.json();

      if (!results.organic_results) {
        if (filterYear) {
          throw new Error(
            `'organic_results' key not found for query: '${query}' with filtering on year=${filterYear}. Use a less restrictive query or do not filter on year.`
          );
        }
        throw new Error(
          `'organic_results' key not found for query: '${query}'. Use a less restrictive query.`
        );
      }

      if (results.organic_results.length === 0) {
        const yearFilterMessage = filterYear ? ` with filter year=${filterYear}` : '';
        return `No results found for '${query}'${yearFilterMessage}. Try with a more general query, or remove the year filter.`;
      }

      const webSnippets = results.organic_results.map((page, idx) => {
        const datePublished = page.date ? `\nDate published: ${page.date}` : '';
        const source = page.source ? `\nSource: ${page.source}` : '';
        const snippet = page.snippet ? `\n${page.snippet}` : '';

        return `${idx}. [${page.title}](${page.link})${datePublished}${source}${snippet}`
          .replace("Your browser can't play this video.", '');
      });

      return `## Search Results\n${webSnippets.join('\n\n')}`;
    } catch (e) {
      throw new Error(`Search failed: ${e.message}`);
    }
  }
}

export class VisitWebpageTool extends Tool {
  static name = 'visit_webpage';
  static description = 'Visits a webpage at the given url and reads its content as a markdown string. Use this to browse webpages.';
  static inputs = {
    url: {
      type: 'string',
      description: 'The url of the webpage to visit.'
    }
  };
  static outputType = 'string';

  constructor() {
    super();
    try {
      this.markdownify = require('markdownify');
    } catch (e) {
      throw new Error(
        'You must install packages `markdownify` and `node-fetch` to run this tool: run `npm install markdownify node-fetch`.'
      );
    }
  }

  async forward(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const html = await response.text();
      let markdownContent = this.markdownify(html).trim();

      markdownContent = markdownContent.replace(/\n{3,}/g, '\n\n');

      return markdownContent;
    } catch (e) {
      if (e.name === 'FetchError') {
        return `Error fetching the webpage: ${e.message}`;
      }
      return `An unexpected error occurred: ${e.message}`;
    }
  }
}
