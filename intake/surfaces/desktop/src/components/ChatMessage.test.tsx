import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatMessage } from './ChatMessage';

describe('ChatMessage Vault fallback notice', () => {
  it('shows the failed provider and the actual serving model on the assistant message', () => {
    render(
      <ChatMessage
        message={{
          role: 'assistant',
          content: 'Here is the answer.',
          fallback: { provider: 'deepseek', model: 'glm-5.2' },
        }}
      />,
    );
    expect(screen.getByText('deepseek failed — answered by GLM (glm-5.2)')).toBeInTheDocument();
    expect(screen.getByText('Here is the answer.')).toBeInTheDocument();
  });

  it('renders the notice without a model suffix when the Vault omitted it', () => {
    render(
      <ChatMessage
        message={{
          role: 'assistant',
          content: 'Partial answer.',
          fallback: { provider: 'mistral', model: null },
        }}
      />,
    );
    expect(screen.getByText('mistral failed — answered by GLM')).toBeInTheDocument();
  });

  it('renders no notice for directly served or user messages', () => {
    const { rerender } = render(
      <ChatMessage message={{ role: 'assistant', content: 'Direct answer.' }} />,
    );
    expect(screen.queryByText(/failed — answered by GLM/)).not.toBeInTheDocument();

    rerender(
      <ChatMessage
        message={{
          role: 'user',
          content: 'A user message.',
          fallback: { provider: 'openai', model: 'glm-5.2' },
        }}
      />,
    );
    expect(screen.queryByText(/failed — answered by GLM/)).not.toBeInTheDocument();
  });
});
