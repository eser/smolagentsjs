export class SystemPromptStep {
    constructor(content) {
        this.content = content;
        this.type = 'system';
    }

    toString() {
        return this.content;
    }
}

export class HumanInputStep {
    constructor(content) {
        this.content = content;
        this.type = 'human';
    }

    toString() {
        return this.content;
    }
}

export class AssistantOutputStep {
    constructor(content) {
        this.content = content;
        this.type = 'assistant';
    }

    toString() {
        return this.content;
    }
} 
