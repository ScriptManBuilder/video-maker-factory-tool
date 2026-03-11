# Video Factory GUI

## Overview

**Video Factory GUI** is a graphical user interface designed to simplify the creation of custom videos. It provides tools for combining assets like fonts, music, and templates into professional-quality video outputs. This project is ideal for content creators, marketers, and anyone looking to automate video production with a user-friendly interface.

---

## Key Features

1. **Font Management**:
   - Includes a curated set of fonts for overlays and text effects.
   - Easily add new fonts by dropping `.ttf` or `.otf` files into the `assets/fonts` directory.
   - Supports live font previews in the GUI.

2. **Music Integration**:
   - Preloaded with categorized music tracks (e.g., ambient, epic, trailer).
   - Add your own music files to the `assets/music` directory.

3. **Templates**:
   - Ready-to-use JSON templates for hooks and satisfying animations.
   - Customize templates to fit your video style.

4. **Automation Scripts**:
   - Scripts for concatenation, rendering, and server management.
   - Automate repetitive tasks to save time.

5. **Live Preview**:
   - Real-time updates for fonts, music, and templates in the GUI.

---

## How to Use

1. **Setup**:
   - Clone the repository and install dependencies using `npm install`.
   - Ensure all required assets (fonts, music, templates) are in their respective directories.

2. **Add Fonts**:
   - Drop `.ttf` or `.otf` files into `assets/fonts`.
   - Open the GUI and select your font from the dropdown menu.

3. **Add Music**:
   - Place audio files in `assets/music` under the appropriate category.

4. **Generate Videos**:
   - Launch the GUI and select your desired fonts, music, and templates.
   - Click **Generate Video** to create your output.

---

## Directory Structure

- **assets/fonts**: Font files for text overlays.
- **assets/music**: Music tracks categorized by mood and style.
- **templates**: JSON templates for animations and hooks.
- **scripts**: Automation scripts for video processing.
- **src/gui.html**: The main graphical interface.

---

## Contribution

Contributions are welcome! Feel free to submit pull requests for new features, bug fixes, or additional templates.
