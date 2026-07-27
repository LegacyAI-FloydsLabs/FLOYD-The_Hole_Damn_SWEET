import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InlineEditOverlay } from '../src/editor/InlineEditOverlay';
import { HostProvider } from '../src/platform/HostProvider';
import { MockHostGateway } from '../src/platform/host';

describe('Inline Edit review surface', () => {
  it('opens from the Monaco request event and shows the exact selection', async () => {
    const gateway = new MockHostGateway();
    render(<HostProvider config={gateway.config} gateway={gateway}><InlineEditOverlay /></HostProvider>);
    await act(async () => window.dispatchEvent(new CustomEvent('cursem:inline-edit-requested', { detail: {
      path: '/test/workspace/main.ts', languageId: 'typescript', fullContent: 'const value = 1;', selectedText: 'value',
      startLine: 1, startCol: 7, endLine: 1, endCol: 12,
    } })));
    expect(screen.getByRole('dialog', { name: 'CURSEM Inline Edit' })).toBeInTheDocument();
    expect(screen.getByText('/test/workspace/main.ts · lines 1–1')).toBeInTheDocument();
    expect(screen.getByText('value')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply and checkpoint' })).toBeDisabled();
  });
});
