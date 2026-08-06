/**
 * Chat Message Component
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { Message } from '@/types';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { User, Bot, AlertTriangle, Copy, Check } from 'lucide-react';

interface ChatMessageProps {
  message: Message;
  isStreaming?: boolean;
}

export function ChatMessage({ message, isStreaming }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <div className={cn(
      'flex gap-3',
      isUser ? 'justify-end' : 'justify-start',
    )}>
      {!isUser && (
        <div className="w-8 h-8 rounded-full bg-sky-600 flex items-center justify-center flex-shrink-0">
          <Bot className="w-5 h-5" />
        </div>
      )}

      <div className={cn(
        'group relative max-w-[70%] min-w-0 rounded-lg px-4 py-3 break-words',
        isUser
          ? 'bg-sky-600 text-white'
          : 'bg-slate-800 text-slate-100',
      )}>
        {!isUser && !isStreaming && (
          <button
            onClick={handleCopy}
            aria-label={copied ? 'Copied' : 'Copy message'}
            title={copied ? 'Copied' : 'Copy'}
            className="absolute top-1.5 right-1.5 p-1 rounded bg-slate-700/80 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity hover:text-white"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
        {!isUser && message.fallback && (
          <div className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1 mb-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>
              {message.fallback.provider} failed — answered by GLM
              {message.fallback.model ? ` (${message.fallback.model})` : ''}
            </span>
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {message.attachments.map((att, i) => (
              att.type === 'image' ? (
                <img
                  key={i}
                  src={`data:${att.mimeType || 'image/jpeg'};base64,${att.data}`}
                  alt={att.name}
                  className="max-w-[200px] max-h-[200px] rounded-md border border-white/20"
                />
              ) : att.type === 'video' ? (
                <video
                  key={i}
                  src={`data:${att.mimeType || 'video/mp4'};base64,${att.data}`}
                  controls
                  className="max-w-[240px] max-h-[200px] rounded-md border border-white/20"
                />
              ) : (
                <div key={i} className="flex items-center gap-2 bg-black/20 px-3 py-2 rounded-md text-sm">
                  <span className="font-mono truncate max-w-[150px]">{att.name}</span>
                </div>
              )
            ))}
          </div>
        )}
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none break-words">
            <ReactMarkdown
              components={{
                code({ node, className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  const isInline = !match;
                  
                  if (isInline) {
                    return (
                      <code className="bg-slate-700 px-1 py-0.5 rounded text-sm break-all" {...props}>
                        {children}
                      </code>
                    );
                  }
                  
                  return (
                    <SyntaxHighlighter
                      style={oneDark as any}
                      language={match[1]}
                      PreTag="div"
                      className="rounded-lg !bg-slate-900 !mt-2 !mb-2 !max-w-full overflow-x-auto"
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  );
                },
                p({ children }) {
                  return <p className="mb-2 last:mb-0">{children}</p>;
                },
                ul({ children }) {
                  return <ul className="list-disc list-inside mb-2">{children}</ul>;
                },
                ol({ children }) {
                  return <ol className="list-decimal list-inside mb-2">{children}</ol>;
                },
                table({ children }) {
                  // Wide tables scroll inside the bubble instead of
                  // stretching the chat column past the frame.
                  return <div className="overflow-x-auto mb-2"><table>{children}</table></div>;
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
            {isStreaming && (
              <span className="inline-block w-2 h-4 bg-sky-400 animate-pulse ml-1" />
            )}
          </div>
        )}
      </div>
      
      {isUser && (
        <div className="w-8 h-8 rounded-full bg-slate-600 flex items-center justify-center flex-shrink-0">
          <User className="w-5 h-5" />
        </div>
      )}
    </div>
  );
}
