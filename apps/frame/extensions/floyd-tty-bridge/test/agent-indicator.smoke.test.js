import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const scriptPath = path.resolve(__dirname, '../agent-indicator.js');
const scriptContent = fs.readFileSync(scriptPath, 'utf-8');

describe('agent-indicator.js smoke tests', () => {
  let mockElements = {};
  let mockShadowRoots = {};

  beforeEach(() => {
    mockElements = {};
    mockShadowRoots = {};

    // Create a more robust mock document for this specific test
    global.document = {
      getElementById: vi.fn((id) => mockElements[id] || null),
      createElement: vi.fn((tag) => {
        const el = {
          tagName: tag.toUpperCase(),
          id: '',
          className: '',
          attributes: {},
          style: {},
          children: [],
          textContent: '',
          parentNode: null,
          setAttribute: vi.fn(function(key, val) { this.attributes[key] = val; }),
          getAttribute: vi.fn(function(key) { return this.attributes[key]; }),
          appendChild: vi.fn(function(child) {
            child.parentNode = this;
            this.children.push(child);
          }),
          removeChild: vi.fn(function(child) {
            const idx = this.children.indexOf(child);
            if (idx > -1) this.children.splice(idx, 1);
            child.parentNode = null;
            if (child.id && mockElements[child.id]) {
              delete mockElements[child.id];
            }
          }),
          addEventListener: vi.fn(function(event, cb) {
            if (!this.listeners) this.listeners = {};
            this.listeners[event] = cb;
          }),
          click: function() {
            if (this.listeners && this.listeners['click']) {
              this.listeners['click']();
            }
          },
          attachShadow: vi.fn(function(opts) {
            const shadow = {
              appendChild: vi.fn(function(child) {
                if (!this.children) this.children = [];
                this.children.push(child);
              }),
              querySelector: vi.fn(function(sel) {
                if (!this.children) return null;
                if (sel.startsWith('.')) {
                  const className = sel.substring(1);
                  return this.children.find(c => c.className === className) || null;
                }
                return null;
              })
            };
            mockShadowRoots[this.id || 'temp'] = shadow;
            this.shadowRoot = shadow;
            return shadow;
          })
        };
        
        // Intercept id assignment to track elements
        Object.defineProperty(el, 'id', {
          get: function() { return this._id; },
          set: function(val) { 
            this._id = val; 
            if (val) mockElements[val] = this;
          }
        });
        
        return el;
      }),
      body: {
        children: [],
        appendChild: vi.fn(function(child) {
          child.parentNode = this;
          this.children.push(child);
        }),
        removeChild: vi.fn(function(child) {
          const idx = this.children.indexOf(child);
          if (idx > -1) this.children.splice(idx, 1);
          child.parentNode = null;
          if (child.id && mockElements[child.id]) {
            delete mockElements[child.id];
          }
        })
      },
      documentElement: {
        children: [],
        appendChild: vi.fn(function(child) {
          child.parentNode = this;
          this.children.push(child);
        }),
        removeChild: vi.fn(function(child) {
          const idx = this.children.indexOf(child);
          if (idx > -1) this.children.splice(idx, 1);
          child.parentNode = null;
          if (child.id && mockElements[child.id]) {
            delete mockElements[child.id];
          }
        })
      }
    };
    
    // Setup chrome mock
    global.chrome = {
      runtime: {
        onMessage: {
          addListener: vi.fn()
        },
        sendMessage: vi.fn()
      }
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads without errors', () => {
    expect(() => {
      eval(scriptContent);
    }).not.toThrow();
  });

  it('registers chrome.runtime.onMessage listener', () => {
    eval(scriptContent);
    expect(global.chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(typeof global.chrome.runtime.onMessage.addListener.mock.calls[0][0]).toBe('function');
  });

  it('does not create indicator elements before AGENT_WORKING message', () => {
    eval(scriptContent);
    const host = document.getElementById('floyd-agent-indicator-host');
    expect(host).toBeNull();
  });
  
  it('creates indicator on AGENT_WORKING and removes on AGENT_DONE', () => {
    eval(scriptContent);
    const listener = global.chrome.runtime.onMessage.addListener.mock.calls[0][0];
    
    // Trigger working
    listener({ type: 'AGENT_WORKING' });
    const host = document.getElementById('floyd-agent-indicator-host');
    expect(host).not.toBeNull();
    expect(host.getAttribute('data-floyd-indicator')).toBe('true');
    
    // Verify shadow DOM contents
    const shadow = host.shadowRoot;
    expect(shadow).toBeDefined();
    const overlay = shadow.querySelector('.floyd-overlay');
    const stopBtn = shadow.querySelector('.floyd-stop-btn');
    expect(overlay).not.toBeNull();
    expect(stopBtn).not.toBeNull();
    
    // Trigger done
    listener({ type: 'AGENT_DONE' });
    expect(document.getElementById('floyd-agent-indicator-host')).toBeNull();
  });

  it('sends AGENT_STOP message and removes indicator when stop button is clicked', () => {
    eval(scriptContent);
    const listener = global.chrome.runtime.onMessage.addListener.mock.calls[0][0];
    
    // Trigger working
    listener({ type: 'AGENT_WORKING' });
    const host = document.getElementById('floyd-agent-indicator-host');
    const stopBtn = host.shadowRoot.querySelector('.floyd-stop-btn');
    
    // Click stop button
    stopBtn.click();
    
    // Verify message sent
    expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'AGENT_STOP' });
    
    // Verify indicator removed
    expect(document.getElementById('floyd-agent-indicator-host')).toBeNull();
  });

  it('is idempotent (does not create multiple hosts)', () => {
    eval(scriptContent);
    const listener = global.chrome.runtime.onMessage.addListener.mock.calls[0][0];
    
    // Trigger working multiple times
    listener({ type: 'AGENT_WORKING' });
    listener({ type: 'AGENT_WORKING' });
    listener({ type: 'AGENT_WORKING' });
    
    // Since our mock document.createElement tracks by ID, we can check how many times appendChild was called on body
    expect(document.body.appendChild).toHaveBeenCalledTimes(1);
  });
});
