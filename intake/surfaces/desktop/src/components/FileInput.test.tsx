import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileInput } from './FileInput';

describe('FileInput', () => {
  it('uses directly operable native file and folder inputs without changing the icon layout', async () => {
    const onAttachmentsChange = vi.fn();
    render(
      <FileInput
        attachments={[]}
        onAttachmentsChange={onAttachmentsChange}
      />,
    );

    const fileInput = screen.getByLabelText('Attach files');
    const folderInput = screen.getByLabelText('Attach a folder');

    expect(fileInput).toHaveAttribute('type', 'file');
    expect(fileInput).toHaveClass('absolute', 'inset-0', 'opacity-0');
    expect(folderInput).toHaveAttribute('webkitdirectory', '');

    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(onAttachmentsChange).toHaveBeenCalledWith([
        expect.objectContaining({
          file,
          type: 'document',
        }),
      ]);
    });
  });
});

