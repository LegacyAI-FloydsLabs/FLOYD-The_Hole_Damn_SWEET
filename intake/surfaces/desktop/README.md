# Floyd Desktop

AI Assistant Desktop Application - Web Version

## Overview

Floyd Desktop is an AI-powered assistant application with support for multiple LLM providers, tool execution via MCP (Model Context Protocol), and a modern responsive web interface.

## Features

- **Multi-Provider Support**: Anthropic Claude, OpenAI, GLM, and custom endpoints
- **MCP Tool Integration**: Execute tools via Model Context Protocol servers
- **Streaming Responses**: Real-time streaming of AI responses
- **Session Management**: Persistent chat sessions with history
- **Skills System**: Extensible skill framework for custom behaviors
- **Projects Manager**: Organize work by project
- **Chrome Extension Integration**: WebSocket-based MCP server for browser automation

## Quick Start

```bash
# Install dependencies
npm install

# Start development server (runs both client and server)
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## Development

- **Client**: Vite + React + TypeScript
- **Server**: Express + TypeScript
- **Styling**: Tailwind CSS with custom CRUSH theme
- **Testing**: Vitest + Playwright

## Environment

Create a `.env.local` file:

```env
ANTHROPIC_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
# Add other provider keys as needed
```

## Project Structure

```
├── src/              # React client source
├── server/           # Express backend
├── docs/             # Documentation
├── public/           # Static assets
└── dist/             # Build output
```

## License

MIT License - see [LICENSE](LICENSE) file

## Governing Document

See [FLOYD.MD](FLOYD.MD) for repository governance and agent operating instructions.
