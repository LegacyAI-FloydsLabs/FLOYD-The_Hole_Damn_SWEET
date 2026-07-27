/**
 * MCP Resource Parser exports
 */

export {
	MCPResourceParser,
	getMCPResourceParser,
	createFileResolver,
	createMemoryResolver,
	createHTTPResolver,
	formatMention,
	createMention,
} from './resource-parser';

export type {
	ResourceMention,
	ResourceValue,
	ResourceResolver,
	ParseOptions,
	ParseResult,
} from './resource-parser';
