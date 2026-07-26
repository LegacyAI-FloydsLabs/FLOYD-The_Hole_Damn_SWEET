#!/usr/bin/env python3
import os
import sys
import json
import curses
import mimetypes
import locale
from datetime import datetime

# Enforce UTF-8 locale for stable TUI rendering
try:
    locale.setlocale(locale.LC_ALL, '')
except Exception:
    pass

# OSC 7701 for AI Telemetry
OSC_START = "\x1b]7701;"
OSC_END = "\x07"

def emit_telemetry(path):
    """Silently emit JSON metadata about the highlighted file via OSC 7701.
    Uses low-level os.write to avoid corrupting the curses stdout buffer.
    """
    try:
        if not os.path.exists(path):
            return
        
        is_dir = os.path.isdir(path)
        size = os.path.getsize(path) if not is_dir else 0
        mtype, _ = mimetypes.guess_type(path)
        
        metadata = {
            "type": "file_highlight",
            "path": os.path.abspath(path),
            "is_directory": is_dir,
            "size": size,
            "mime_type": mtype or ("directory" if is_dir else "application/octet-stream"),
            "modified": datetime.fromtimestamp(os.path.getmtime(path)).isoformat()
        }
        
        # Add a small snippet if it's a text file
        if not is_dir and size > 0 and (mtype and mtype.startswith("text") or size < 10240):
            try:
                with open(path, 'r', errors='ignore') as f:
                    metadata["snippet"] = f.read(512)
            except:
                pass

        # Low-level write directly to fileno to bypass curses buffer
        payload = f"{OSC_START}{json.dumps(metadata)}{OSC_END}".encode('utf-8')
        os.write(sys.stdout.fileno(), payload)
    except Exception:
        pass

class FloydExplorer:
    def __init__(self, stdscr):
        self.stdscr = stdscr
        self.stdscr.keypad(True) # Enable arrow keys and special keys
        self.left_pane_dir = os.getcwd()
        self.right_pane_dir = os.path.expanduser("~")
        self.active_pane = 0 # 0 for left, 1 for right
        self.cursor_pos = [0, 0] # indices for [left, right]
        self.panes = [[], []] # file lists
        
        curses.curs_set(1) # Show hardware cursor
        self.stdscr.nodelay(0)
        self.refresh_files()
        self.draw()
        self.run()

    def refresh_files(self):
        for i, path in enumerate([self.left_pane_dir, self.right_pane_dir]):
            try:
                items = sorted(os.listdir(path))
                self.panes[i] = [".."] + items
            except Exception:
                self.panes[i] = [".."]
            
            # Bound cursor
            if self.cursor_pos[i] >= len(self.panes[i]):
                self.cursor_pos[i] = max(0, len(self.panes[i]) - 1)

    def draw(self):
        self.stdscr.erase()
        height, width = self.stdscr.getmaxyx()
        pane_width = width // 2
        
        for i in range(2):
            x_offset = i * pane_width
            title = self.left_pane_dir if i == 0 else self.right_pane_dir
            attr = curses.A_REVERSE if self.active_pane == i else curses.A_BOLD
            
            # Draw header
            self.stdscr.addstr(0, x_offset, title[:pane_width-1].ljust(pane_width-1), attr)
            
            # Draw files
            for idx, item in enumerate(self.panes[i]):
                if idx >= height - 2: break
                
                y = idx + 1
                display_text = item[:pane_width-2]
                if self.active_pane == i and self.cursor_pos[i] == idx:
                    self.stdscr.addstr(y, x_offset, f"> {display_text}".ljust(pane_width-1), curses.A_REVERSE)
                else:
                    is_dir = os.path.isdir(os.path.join(self.left_pane_dir if i == 0 else self.right_pane_dir, item))
                    color = curses.A_BOLD if is_dir else curses.A_NORMAL
                    self.stdscr.addstr(y, x_offset, f"  {display_text}".ljust(pane_width-1), color)

        # Status bar
        current_dir = self.left_pane_dir if self.active_pane == 0 else self.right_pane_dir
        current_item = self.panes[self.active_pane][self.cursor_pos[self.active_pane]]
        self.stdscr.addstr(height-1, 0, f" [TAB] Switch Pane | [ENTER] Open | [Q] Quit | Item: {current_item}"[:width-1], curses.A_REVERSE)
        
        self.stdscr.refresh()
        
        # Telemetry
        full_path = os.path.join(current_dir, current_item)
        emit_telemetry(full_path)

    def run(self):
        while True:
            key = self.stdscr.getch()
            
            if key == ord('q'):
                break
            elif key == curses.KEY_RESIZE:
                curses.update_lines_cols()
                self.stdscr.clear()
                self.draw()
                continue
            elif key == curses.KEY_UP:
                self.cursor_pos[self.active_pane] = max(0, self.cursor_pos[self.active_pane] - 1)
            elif key == curses.KEY_DOWN:
                self.cursor_pos[self.active_pane] = min(len(self.panes[self.active_pane]) - 1, self.cursor_pos[self.active_pane] + 1)
            elif key == 9: # TAB
                self.active_pane = 1 - self.active_pane
            elif key == 10: # ENTER
                current_dir = self.left_pane_dir if self.active_pane == 0 else self.right_pane_dir
                item = self.panes[self.active_pane][self.cursor_pos[self.active_pane]]
                new_path = os.path.abspath(os.path.join(current_dir, item))
                
                if os.path.isdir(new_path):
                    if self.active_pane == 0: self.left_pane_dir = new_path
                    else: self.right_pane_dir = new_path
                    self.cursor_pos[self.active_pane] = 0
                    self.refresh_files()
            
            self.draw()

def main():
    curses.wrapper(FloydExplorer)

if __name__ == "__main__":
    main()
