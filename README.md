# QwaleCode 🚀 💻

Lightweight coding IDE built by Faraaz Jan.

QwaleCode is an Electron-based desktop IDE focused on a compact, VS Code-style workflow. It combines a project explorer, Monaco code editor, integrated terminal, source control tools, and an AI coding panel into a single app.

## Overview

The application is organized into three main areas:

- Explorer and Source Control on the left 📁🎛️
- Code editor in the center ✍️
- AI Code panel on the right 🤖

It also includes a bottom terminal panel with multiple terminal sessions, file search, recent projects, theming, and menu-driven file/edit/window actions.

## Features

- Open and manage local folders as projects
- Browse files and folders in a project explorer
- Create, rename, move, copy, paste, and delete files and folders
- Open files in tabs with Monaco syntax highlighting
- Save, Save As, and Save All support
- Integrated terminal with multiple sessions
- Git source control panel with commit, push, fetch, pull, branch switching, and branch creation
- AI Code panel for coding assistance, file edits, and command execution
- Light and dark themes
- Recent project history
- Search files by name
- More coming soon

## Requirements

- Windows, macOS, or Linux
- Node.js installed locally
- Git installed locally if you want to use Source Control features

## Setup

1. Clone or copy the repository to your machine.
2. Install dependencies:

```bash
npm install
```

3. Start the app:

```bash
npm start
```

## Usage

### Opening a project

- Use `File > Open Folder`
- Or press `Ctrl+O`

### Working with files

- Single-click a file to preview it
- Double-click a file to keep it open permanently
- Use the tab close buttons to close files
- Use `Ctrl+S` to save the current file
- Use `Ctrl+Shift+S` to save as
- Use `Ctrl+Alt+S` to save all open files

### Explorer actions

- Right-click files and folders for create, rename, copy, cut, paste, and delete actions
- Use inline rename/create fields when prompted

### Terminal

- The terminal panel is docked at the bottom of the window
- Use the `+` button to open new sessions
- Use the terminal dropdown to choose different shell profiles when available

### Source Control

- Switch to the Version Control panel using the left sidebar icon
- Initialize a Git repository if the folder is not already one
- Commit changes, push, fetch, pull, and switch branches

### AI Code panel

- The AI panel is available on the right side of the editor
- Enter an OpenAI API key to use it
- The AI can read and edit project files and run commands through built-in tool actions
- User messages can be revisited with the rewind button beside each prompt

## Keyboard Shortcuts

- `Ctrl+O` - Open folder
- `Ctrl+S` - Save file
- `Ctrl+Shift+S` - Save file as
- `Ctrl+Alt+S` - Save all files
- `Ctrl+Shift+W` - Close folder
- `Ctrl+Alt+L` - Toggle theme
- `Ctrl+F` - Find in editor
- `Ctrl+H` - Find and replace

## Project Structure

- `src/main.js` - Electron main process, windows, menus, file system, Git, terminal, and AI command handlers
- `src/preload.js` - Secure renderer API bridge
- `src/renderer/renderer.js` - UI behavior, editor orchestration, terminal handling, Git UI, and AI chat logic
- `src/renderer/styles.css` - App styling and theme rules
- `src/renderer/index.html` - UI layout

## Scripts

- `npm start` - Launch QwaleCode in Electron

## Notes

- The app uses local storage for some UI preferences and the OpenAI API key.
- The AI panel starts visible by default in the current configuration, but it is not persisted across launches.
- If the app cannot open a terminal shell, make sure the requested shell profile is installed and available on your system.

## License

CC BY-NC-ND 4.0
