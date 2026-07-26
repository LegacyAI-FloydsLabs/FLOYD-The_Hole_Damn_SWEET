/**
 * RAGBOT Vision Agent — Tool Definitions for Gemini Function Calling
 *
 * These are the tools the Gemini Live session can invoke to analyze,
 * navigate, and interact with web pages through structured DOM access.
 */

export const VISION_TOOLS = {
  functionDeclarations: [
    {
      name: 'analyze_page',
      description: 'Perform a comprehensive analysis of the current web page. Returns layout structure, accessibility violations, CSS issues, content problems, and an overall quality score. Use this when you need a full picture of the page.',
      parameters: {
        type: "OBJECT",
        properties: {
          include_css: {
            type: "BOOLEAN",
            description: 'Include detailed CSS analysis (layout systems, custom properties, animations). Default true.',
          },
          include_accessibility: {
            type: "BOOLEAN",
            description: 'Include WCAG accessibility audit. Default true.',
          },
          viewport_scroll: {
            type: "BOOLEAN",
            description: 'Scroll through the entire page to capture below-fold content. Default false.',
          },
        },
      },
    },
    {
      name: 'analyze_element',
      description: 'Get detailed information about a specific element: computed styles, position, accessibility attributes, text content, and children. Use this to inspect a specific part of the page.',
      parameters: {
        type: "OBJECT",
        properties: {
          selector: {
            type: "STRING",
            description: 'CSS selector for the element (e.g. "#login-btn", ".nav-menu", "header")',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'find_elements',
      description: 'Search for elements by visible text, aria-label, placeholder, alt text, or role. Use this when you know what something says or does but not its selector.',
      parameters: {
        type: "OBJECT",
        properties: {
          query: {
            type: "STRING",
            description: 'Text to search for (e.g. "Login", "Submit", "Search box")',
          },
          search_by: {
            type: "STRING",
            description: 'What to search: "text", "aria", "placeholder", "alt", "role", or "any" (default "any")',
          },
          limit: {
            type: "NUMBER",
            description: 'Maximum results to return. Default 10.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'check_accessibility',
      description: 'Run a focused WCAG accessibility audit. Returns violations grouped by severity with specific elements and fix suggestions.',
      parameters: {
        type: "OBJECT",
        properties: {
          scope: {
            type: "STRING",
            description: 'CSS selector to limit audit scope, or empty for full page.',
          },
          level: {
            type: "STRING",
            description: 'WCAG level to check: "A", "AA" (default), or "AAA".',
          },
        },
      },
    },
    {
      name: 'extract_css',
      description: 'Extract computed CSS properties for an element. Returns all visual styling including colors, fonts, spacing, layout, transforms, and animations.',
      parameters: {
        type: "OBJECT",
        properties: {
          selector: {
            type: "STRING",
            description: 'CSS selector for the element.',
          },
          properties: {
            type: "ARRAY",
            items: { type: "STRING" },
            description: 'Specific CSS properties to extract. Empty for all relevant properties.',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'check_contrast',
      description: 'Check color contrast ratio between text and background for specific elements or the entire page. Returns WCAG AA/AAA pass/fail status.',
      parameters: {
        type: "OBJECT",
        properties: {
          selector: {
            type: "STRING",
            description: 'CSS selector to check, or empty for all text elements.',
          },
        },
      },
    },
    {
      name: 'click_element',
      description: 'Click on a specific element. Returns what changed on the page after the click.',
      parameters: {
        type: "OBJECT",
        properties: {
          selector: {
            type: "STRING",
            description: 'CSS selector for the element to click.',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'scroll_to',
      description: 'Scroll to a specific element or position on the page.',
      parameters: {
        type: "OBJECT",
        properties: {
          target: {
            type: "STRING",
            description: 'CSS selector, or "top", "bottom", "up", "down".',
          },
        },
        required: ['target'],
      },
    },
    {
      name: 'navigate_to',
      description: 'Navigate the browser to a new URL.',
      parameters: {
        type: "OBJECT",
        properties: {
          url: {
            type: "STRING",
            description: 'The URL to navigate to.',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'extract_text',
      description: 'Extract text content from one or more elements.',
      parameters: {
        type: "OBJECT",
        properties: {
          selector: {
            type: "STRING",
            description: 'CSS selector (can match multiple elements).',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'get_page_state',
      description: 'Get current page metadata: URL, title, viewport size, scroll position, document dimensions, active element.',
      parameters: {
        type: "OBJECT",
        properties: {},
      },
    },
    {
      name: 'write_observation',
      description: 'Write the latest analysis results to the observation markdown file for external LLM consumption.',
      parameters: {
        type: "OBJECT",
        properties: {
          summary: {
            type: "STRING",
            description: 'A human-readable summary to prepend to the observation.',
          },
        },
      },
    },
    {
      name: 'read_commands',
      description: 'Check the command markdown file for new instructions from an external LLM.',
      parameters: {
        type: "OBJECT",
        properties: {},
      },
    },
    {
      name: 'open_tab',
      description: 'Open a new browser tab with the specified URL. Use this when you need to navigate to a new page without replacing the current one.',
      parameters: {
        type: "OBJECT",
        properties: {
          url: {
            type: "STRING",
            description: 'The URL to open in the new tab.',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'close_tab',
      description: 'Close a specific browser tab by its ID. Use this to clean up tabs or remove unwanted pages.',
      parameters: {
        type: "OBJECT",
        properties: {
          tab_id: {
            type: "NUMBER",
            description: 'The ID of the tab to close.',
          },
        },
        required: ['tab_id'],
      },
    },
    {
      name: 'switch_tab',
      description: 'Switch focus to a different browser tab. Use this to move between open tabs.',
      parameters: {
        type: "OBJECT",
        properties: {
          tab_id: {
            type: "NUMBER",
            description: 'The ID of the tab to switch to.',
          },
        },
        required: ['tab_id'],
      },
    },
    {
      name: 'list_tabs',
      description: 'List all open browser tabs with their IDs, URLs, and titles. Use this to see what tabs are currently open.',
      parameters: {
        type: "OBJECT",
        properties: {},
      },
    },
    {
      name: 'type_text',
      description: 'Type text into a form input field. Use this to fill text inputs, search boxes, or text areas.',
      parameters: {
        type: "OBJECT",
        properties: {
          selector: {
            type: "STRING",
            description: 'CSS selector for the input element.',
          },
          text: {
            type: "STRING",
            description: 'The text to type into the input.',
          },
          clear_first: {
            type: "BOOLEAN",
            description: 'Clear the input before typing. Default false.',
          },
        },
        required: ['selector', 'text'],
      },
    },
    {
      name: 'fill_form',
      description: 'Fill multiple form fields at once. Use this to populate entire forms efficiently.',
      parameters: {
        type: "OBJECT",
        properties: {
          fields: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                selector: {
                  type: "STRING",
                  description: 'CSS selector for the form field.',
                },
                value: {
                  type: "STRING",
                  description: 'The value to set in the field.',
                },
              },
              required: ['selector', 'value'],
            },
            description: 'Array of {selector, value} objects to fill.',
          },
        },
        required: ['fields'],
      },
    },
    {
      name: 'select_option',
      description: 'Select an option from a dropdown or select element. Use this to choose from predefined options.',
      parameters: {
        type: "OBJECT",
        properties: {
          selector: {
            type: "STRING",
            description: 'CSS selector for the select element.',
          },
          value: {
            type: "STRING",
            description: 'The value or text of the option to select.',
          },
        },
        required: ['selector', 'value'],
      },
    },
    {
      name: 'take_screenshot',
      description: 'Capture a screenshot of the current page. Use this to visually document the page state.',
      parameters: {
        type: "OBJECT",
        properties: {
          full_page: {
            type: "BOOLEAN",
            description: 'Capture the entire page including below-fold content. Default false.',
          },
        },
      },
    },
    {
      name: 'wait_for_element',
      description: 'Wait for an element to appear on the page. Use this when content loads asynchronously.',
      parameters: {
        type: "OBJECT",
        properties: {
          selector: {
            type: "STRING",
            description: 'CSS selector for the element to wait for.',
          },
          timeout: {
            type: "NUMBER",
            description: 'Maximum time to wait in milliseconds. Default 5000.',
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'get_tab_state',
      description: 'Get the current state of a tab including its URL, title, and ready state. Use this to check tab information.',
      parameters: {
        type: "OBJECT",
        properties: {
          tab_id: {
            type: "NUMBER",
            description: 'The ID of the tab to get state for. Omit for current tab.',
          },
        },
      },
    },
    {
      name: 'execute_local_shell',
      description: 'Execute a bash command on the local machine (host). This runs silently in the background and returns stdout/stderr. Use this for file operations, system checks, or running local scripts.',
      parameters: {
        type: "OBJECT",
        properties: {
          command: {
            type: "STRING",
            description: 'The bash command to execute (e.g. "ls -la", "grep pattern file.txt")',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'query_knowledge',
      description: 'Query the vectorized knowledge base of 12,419 expert documents across 25+ domains including AI/dev, legal, advocacy, and business topics.',
      parameters: {
        type: "OBJECT",
        properties: {
          query: {
            type: "STRING",
            description: 'The search query.',
          },
          collection: {
            type: "STRING",
            description: 'Optional: specific collection to search.',
          },
          top_k: {
            type: "NUMBER",
            description: 'Number of results. Default 5.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'set_of_marks',
      description: 'Render numbered marks (visual labels) on interactive elements. Use this to help grounding when looking at screenshots.',
      parameters: {
        type: "OBJECT",
        properties: {
          show: {
            type: "BOOLEAN",
            description: 'Whether to show or hide the marks. Default true.',
          },
          filter: {
            type: "STRING",
            description: 'Which elements to mark: "interactive" (default), "forms", or "all".',
          },
        },
      },
    },
    {
      name: 'click_mark',
      description: 'Click on a numbered mark created by set_of_marks.',
      parameters: {
        type: "OBJECT",
        properties: {
          mark: {
            type: "NUMBER",
            description: 'The number of the mark to click.',
          },
        },
        required: ['mark'],
      },
    },
  ],
};

// A lightweight subset of tools specifically for the low-latency Voice session.
export const LIVE_VISION_TOOLS = {
  functionDeclarations: VISION_TOOLS.functionDeclarations.filter(tool =>
    [
      'click_element',
      'type_text',
      'scroll_to',
      'navigate_to',
      'analyze_page',
      'get_page_state'
    ].includes(tool.name)
  )
};