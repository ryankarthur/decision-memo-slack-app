# Decision Memo Slack App

> Transform Slack conversations into structured decision documentation using AI-powered analysis.

[![Node.js](https://img.shields.io/badge/Node.js-18.x-green.svg)](https://nodejs.org/)
[![Slack Bolt](https://img.shields.io/badge/Slack-Bolt_Framework-4A154B.svg)](https://slack.dev/bolt-js/)
[![Claude AI](https://img.shields.io/badge/AI-Claude_3.7_Sonnet-orange.svg)](https://anthropic.com)

*Built as a first coding project with help from Claude and Replit. This app runs in Slack and helps users create Decision Memos to capture context around critical company decisions.*

## 🎯 Overview

The Decision Memo Slack App automatically generates comprehensive decision documentation from your team's Slack conversations. Built for teams that value **first-principles thinking**, **ownership**, and **strategic decision-making**.

## 💡 The Problem

In fast-moving companies, critical decisions often happen in Slack threads, meetings, or casual conversations. This valuable context gets lost, making it hard to:
- Remember why decisions were made
- Onboard new team members  
- Learn from past choices
- Maintain institutional knowledge

This app transforms those informal discussions into structured decision documentation that can be referenced long-term.

### Key Features

- **📝 AI-Powered Analysis** - Uses Claude 3.7 Sonnet to extract decision context and reasoning
- **🤖 Smart Clarification** - Asks strategic questions to fill information gaps
- **⚡ Multiple Entry Points** - Slash commands and message shortcuts for flexible usage
- **🧵 Thread-Aware** - Captures entire conversation threads automatically
- **📁 File Support** - Processes uploaded meeting transcripts and documents
- **🎨 Formatted Output** - Slack-optimized formatting ready for copy-paste to Notion

## 🚀 Getting Started

### Prerequisites

- Node.js 18.x or higher
- Slack workspace with admin permissions
- Anthropic API key

### Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment variables**
   ```env
   SLACK_BOT_TOKEN=xoxb-your-bot-token
   SLACK_APP_TOKEN=xapp-your-app-token
   SLACK_SIGNING_SECRET=your-signing-secret
   ANTHROPIC_API_KEY=your-claude-api-key
   PORT=3000
   ```

3. **Run the application**
   ```bash
   npm start
   ```

## 📋 Decision Memo Structure

Every generated memo follows a consistent 5-section framework:

1. **What is the choice you made?** - Clear decision statement
2. **Why make this decision?** - Factors and reasoning
3. **What are the risks?** - Potential downsides and mitigation
4. **What's the reward?** - Benefits and strategic advantages  
5. **What other choices were considered?** - Alternative options evaluated

## 🎮 Usage

### Slash Command
```
/decisionmemo
```
Opens a DM conversation where you can paste context or upload files.

### Message Shortcut
1. Right-click any Slack message or thread
2. Select **"Decision Memo"** from the shortcuts menu
3. Bot captures the conversation and opens a DM for clarification

### Example Workflow
```
You: /decisionmemo
Bot: I'll help you create a Decision Memo. Please paste the relevant conversation...

You: [paste meeting notes or conversation]
Bot: I'm analyzing... Here are my clarifying questions:
     1) What fundamental problem is this decision addressing?
     2) How does this align with our long-term strategy?

You: [answer questions]
Bot: ✅ Here's your Decision Memo that you can copy to Notion:

# Migration to Microservices Architecture

*What is the choice you made?*
We're migrating our monolithic backend to a microservices architecture...
```

## 🏗️ Technical Details

- **Framework**: Slack Bolt (Node.js)
- **AI Engine**: Anthropic Claude 3.7 Sonnet
- **Connection**: Socket Mode (no webhooks required)
- **State**: In-memory storage
- **Deployment**: Platform agnostic

## 🔧 Slack App Configuration

### Required OAuth Scopes
```
commands, chat:write, chat:write.public
im:history, im:write, channels:history, groups:history, mpim:history
```

### Slash Commands
- **Command**: `/decisionmemo`
- **Description**: Create a decision memo from a conversation

### Message Shortcuts
- **Name**: Decision Memo
- **Callback ID**: `call_decision_memo_tool`

### Event Subscriptions
- `message.im` - For DM conversations

## 💰 Usage Costs

- **Claude API**: ~$0.10-$0.50 per decision memo
- **Usage**: 2-4 API calls per memo generation

Monitor usage in the Anthropic Console.

## 🛠️ Development Notes

### Project Structure
```
├── index.js                 # Main application
├── package.json            # Dependencies
├── .env.example           # Environment template
└── README.md             # This file
```

### Key Functions
- `generateClarifyingQuestions()` - AI-powered question generation
- `generateDecisionMemo()` - Structured memo creation
- `handleFileUpload()` - Process uploaded documents

### Testing
```bash
# Test the health endpoint
curl http://localhost:3000/

# Test in Slack
/decisionmemo
```

## 🔍 Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| "Can't access thread messages" | Invite bot to channel: `/invite @Decision Memo` |
| API errors | Check Anthropic API key and quotas |
| File upload fails | Add `files:read` OAuth scope |
| Memory issues | Implement persistent storage for production |

### Monitoring
- Claude API usage in Anthropic Console
- Application logs for error patterns
- Success rate of memo generations



---

**Built with ❤️ for better decision making**
