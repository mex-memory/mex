#!/usr/bin/env bash
# mex scaffold visualizer — launches a local server with interactive graph visualization
set -euo pipefail

# Find scaffold directory (where ROUTER.md lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/ROUTER.md" ]]; then
    SCAFFOLD_DIR="$SCRIPT_DIR"
elif [[ -f "$SCRIPT_DIR/../ROUTER.md" ]]; then
    SCAFFOLD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    echo "Error: Cannot find ROUTER.md. Run this script from the scaffold directory."
    exit 1
fi

PORT=4444

# Check if port is already in use
if lsof -i :$PORT >/dev/null 2>&1; then
    echo "Port $PORT is already in use. Kill the existing process or choose another port."
    exit 1
fi

echo ""
echo "  mex scaffold visualizer"
echo "  ─────────────────────────"
echo "  Serving at http://localhost:$PORT"
echo "  Press Ctrl+C to stop"
echo ""

# Auto-open browser after a short delay
(sleep 1 && {
    if command -v open >/dev/null 2>&1; then
        open "http://localhost:$PORT"
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "http://localhost:$PORT"
    fi
}) &

# Run the embedded Python server
python3 - "$SCAFFOLD_DIR" "$PORT" << 'PYTHON_SERVER'
import sys
import os
import re
import json
import signal
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

SCAFFOLD_DIR = sys.argv[1]
PORT = int(sys.argv[2])

def signal_handler(sig, frame):
    print("\n  Shutting down...")
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


def parse_frontmatter(filepath):
    """Parse YAML frontmatter from a markdown file without PyYAML."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception:
        return None, ''

    # Extract frontmatter between --- delimiters
    match = re.match(r'^---\s*\n(.*?)\n---', content, re.DOTALL)
    if not match:
        return None, content

    fm_text = match.group(1)
    body = content[match.end():].strip()

    result = {
        'name': '',
        'description': '',
        'triggers': [],
        'edges': [],
        'last_updated': ''
    }

    # Parse the frontmatter line by line
    lines = fm_text.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i]

        # Simple key: value
        kv = re.match(r'^(\w[\w_]*):\s*(.+)$', line)
        if kv:
            key, val = kv.group(1), kv.group(2).strip()
            if key in ('name', 'description', 'last_updated'):
                result[key] = val.strip('"').strip("'")
            i += 1
            continue

        # triggers array
        if re.match(r'^triggers:\s*$', line):
            i += 1
            while i < len(lines) and re.match(r'^\s+-\s+', lines[i]):
                val = re.sub(r'^\s+-\s+', '', lines[i]).strip().strip('"').strip("'")
                result['triggers'].append(val)
                i += 1
            continue

        # edges array
        if re.match(r'^edges:\s*$', line):
            i += 1
            while i < len(lines):
                target_match = re.match(r'^\s+-\s+target:\s*(.+)$', lines[i])
                if target_match:
                    edge = {'target': target_match.group(1).strip(), 'condition': ''}
                    i += 1
                    # Look for condition on next line
                    if i < len(lines):
                        cond_match = re.match(r'^\s+condition:\s*(.+)$', lines[i])
                        if cond_match:
                            edge['condition'] = cond_match.group(1).strip()
                            i += 1
                    result['edges'].append(edge)
                else:
                    # Not an edge entry — done with edges block
                    break
            continue

        i += 1

    return result, body


def detect_status(body):
    """Analyze file body content to determine completion status."""
    if not body or not body.strip():
        return 'empty'

    # Remove frontmatter residue
    text = body.strip()

    # Strip headings to see if there's real content
    lines = text.split('\n')
    content_lines = []
    for line in lines:
        stripped = line.strip()
        # Skip empty lines, headings
        if not stripped or stripped.startswith('#'):
            continue
        content_lines.append(stripped)

    if not content_lines:
        return 'empty'

    full_content = '\n'.join(content_lines)

    # Check for annotation comments
    has_comments = bool(re.search(r'<!--.*?-->', full_content, re.DOTALL))
    has_placeholders = bool(re.search(r'\[TO DETERMINE\]|\[TO BE DETERMINED\]', full_content, re.IGNORECASE))

    # Check for real content (non-comment, non-placeholder lines)
    real_lines = []
    # Remove HTML comments
    cleaned = re.sub(r'<!--.*?-->', '', full_content, flags=re.DOTALL)
    for line in cleaned.split('\n'):
        stripped = line.strip()
        if stripped and not re.match(r'^\[TO (BE )?DETERMINE(D)?\]$', stripped, re.IGNORECASE):
            real_lines.append(stripped)

    has_real_content = len(real_lines) > 0

    if not has_real_content:
        # Only comments/placeholders/headings
        return 'empty'

    if has_comments or has_placeholders:
        return 'partial'

    return 'populated'


def parse_routing_table(filepath):
    """Parse the routing table from ROUTER.md."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception:
        return []

    routes = []
    in_table = False
    for line in content.split('\n'):
        stripped = line.strip()
        if stripped.startswith('| Task type'):
            in_table = True
            continue
        if in_table and stripped.startswith('|---'):
            continue
        if in_table and stripped.startswith('|'):
            cells = [c.strip() for c in stripped.split('|')]
            cells = [c for c in cells if c]
            if len(cells) >= 2:
                task_type = cells[0]
                load_target = cells[1]
                # Extract file path from backticks or markdown links
                path_match = re.search(r'`([^`]+)`', load_target)
                if path_match:
                    routes.append({
                        'task': task_type,
                        'target': path_match.group(1)
                    })
        elif in_table and not stripped.startswith('|'):
            break

    return routes


def scan_scaffold():
    """Scan all .md files in the scaffold and return graph data."""
    nodes = []
    edges = []
    node_ids = set()

    # Collect all relevant .md files
    md_files = []

    # Root level scaffold files
    for name in ['ROUTER.md', 'AGENTS.md', 'SETUP.md', 'SYNC.md']:
        path = os.path.join(SCAFFOLD_DIR, name)
        if os.path.isfile(path):
            md_files.append((name, path))

    # Context files
    ctx_dir = os.path.join(SCAFFOLD_DIR, 'context')
    if os.path.isdir(ctx_dir):
        for f in sorted(os.listdir(ctx_dir)):
            if f.endswith('.md'):
                md_files.append((f'context/{f}', os.path.join(ctx_dir, f)))

    # Pattern files
    pat_dir = os.path.join(SCAFFOLD_DIR, 'patterns')
    if os.path.isdir(pat_dir):
        for f in sorted(os.listdir(pat_dir)):
            if f.endswith('.md'):
                md_files.append((f'patterns/{f}', os.path.join(pat_dir, f)))

    # Parse all files
    file_data = {}
    for rel_path, abs_path in md_files:
        fm, body = parse_frontmatter(abs_path)
        if fm is None:
            fm = {'name': rel_path, 'description': '', 'triggers': [], 'edges': [], 'last_updated': ''}

        # Determine type
        if '/' not in rel_path:
            ftype = 'root'
        elif rel_path.startswith('context/'):
            ftype = 'context'
        elif rel_path.startswith('patterns/'):
            ftype = 'pattern'
        else:
            ftype = 'other'

        status = detect_status(body)

        file_data[rel_path] = {
            'id': rel_path,
            'name': fm.get('name', '') or rel_path,
            'filename': rel_path,
            'description': fm.get('description', ''),
            'type': ftype,
            'triggers': fm.get('triggers', []),
            'edges_raw': fm.get('edges', []),
            'last_updated': fm.get('last_updated', ''),
            'status': status,
            'content': body
        }
        node_ids.add(rel_path)

    # Parse routing table from ROUTER.md
    router_path = os.path.join(SCAFFOLD_DIR, 'ROUTER.md')
    routing_table = parse_routing_table(router_path)

    # Build nodes and edges
    for rel_path, data in file_data.items():
        nodes.append({
            'id': data['id'],
            'name': data['name'],
            'filename': data['filename'],
            'description': data['description'],
            'type': data['type'],
            'triggers': data['triggers'],
            'last_updated': data['last_updated'],
            'edge_count': len(data['edges_raw']),
            'status': data['status'],
            'content': data['content']
        })

        for edge in data['edges_raw']:
            target = edge.get('target', '')
            if target in node_ids:
                edges.append({
                    'source': rel_path,
                    'target': target,
                    'condition': edge.get('condition', '')
                })

    return {'nodes': nodes, 'edges': edges, 'routing_table': routing_table}


HTML_PAGE = r'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mex scaffold visualizer</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #0d1117;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    overflow: hidden;
    height: 100vh;
    width: 100vw;
  }

  /* ─── Header ─── */
  #header {
    position: fixed;
    top: 0; left: 0;
    z-index: 100;
    padding: 16px 24px;
    pointer-events: none;
  }
  #header h1 {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.5px;
    color: #ffffff;
  }
  #header h1 span { color: #1944F1; }
  #header p {
    font-size: 11px;
    color: #8b949e;
    margin-top: 2px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    font-weight: 500;
  }

  /* ─── Progress Bar ─── */
  #progress-bar-container {
    position: fixed;
    top: 0; left: 0; right: 0;
    z-index: 150;
    height: 3px;
    background: #21262d;
  }
  #progress-bar-fill {
    height: 100%;
    border-radius: 0 3px 3px 0;
    background: linear-gradient(90deg, #2ea043, #56d364);
    transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
  }
  #progress-bar-fill.pulsing::after {
    content: '';
    position: absolute;
    top: 0; right: 0; bottom: 0;
    width: 80px;
    background: linear-gradient(90deg, transparent, rgba(86, 211, 100, 0.4), transparent);
    animation: progress-pulse 2s ease-in-out infinite;
  }
  @keyframes progress-pulse {
    0%, 100% { opacity: 0; }
    50% { opacity: 1; }
  }
  #progress-label {
    position: fixed;
    top: 7px; left: 50%;
    transform: translateX(-50%);
    z-index: 151;
    font-size: 10px;
    color: #8b949e;
    letter-spacing: 0.5px;
    pointer-events: none;
  }

  /* ─── Navigation Simulator ─── */
  #nav-simulator {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 120;
    display: flex;
    align-items: center;
    gap: 0;
  }
  #nav-input {
    width: 320px;
    padding: 8px 14px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    color: #e6edf3;
    font-size: 13px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  #nav-input:focus {
    border-color: #1944F1;
    box-shadow: 0 0 0 3px rgba(25, 68, 241, 0.15);
  }
  #nav-input::placeholder { color: #484f58; }

  /* ─── Layout Toggle ─── */
  #layout-toggle {
    position: fixed;
    top: 16px; right: 24px;
    z-index: 120;
    display: flex;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    overflow: hidden;
  }
  .layout-btn {
    padding: 7px 14px;
    font-size: 11px;
    font-weight: 500;
    color: #8b949e;
    background: transparent;
    border: none;
    cursor: pointer;
    transition: all 0.2s;
    font-family: inherit;
    letter-spacing: 0.3px;
  }
  .layout-btn.active {
    background: #30363d;
    color: #e6edf3;
  }
  .layout-btn:hover:not(.active) { color: #c9d1d9; }

  /* ─── Legend ─── */
  #legend {
    position: fixed;
    bottom: 40px; left: 24px;
    z-index: 100;
    display: flex;
    gap: 16px;
    font-size: 11px;
    color: #8b949e;
    pointer-events: none;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .legend-ring {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid;
    background: transparent;
  }

  /* ─── Stats Bar ─── */
  #stats-bar {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    z-index: 100;
    height: 28px;
    background: #161b22;
    border-top: 1px solid #21262d;
    display: flex;
    align-items: center;
    padding: 0 24px;
    gap: 24px;
    font-size: 11px;
    color: #484f58;
  }
  .stat-item { display: flex; align-items: center; gap: 5px; }
  .stat-value { color: #8b949e; font-weight: 500; }

  /* ─── SVG ─── */
  svg { width: 100%; height: 100%; display: block; }

  /* ─── Canvas overlay for particles ─── */
  #particle-canvas {
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    pointer-events: none;
    z-index: 5;
  }

  /* ─── Side Panel ─── */
  #side-panel {
    position: fixed;
    top: 0; right: 0;
    width: 380px;
    height: 100vh;
    background: #161b22;
    border-left: 1px solid #30363d;
    z-index: 200;
    transform: translateX(100%);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    overflow-y: auto;
    padding: 0;
  }
  #side-panel.open { transform: translateX(0); }

  .panel-header {
    padding: 20px 20px 14px;
    border-bottom: 1px solid #30363d;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .panel-close {
    background: none;
    border: none;
    color: #8b949e;
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    line-height: 1;
    transition: all 0.15s;
    flex-shrink: 0;
  }
  .panel-close:hover { background: #30363d; color: #e6edf3; }

  .panel-title {
    font-size: 16px;
    font-weight: 600;
    color: #ffffff;
    word-break: break-word;
  }
  .panel-filename {
    font-size: 11px;
    color: #8b949e;
    margin-top: 3px;
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
  }
  .panel-badges {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  .panel-type-badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    padding: 3px 8px;
    border-radius: 12px;
  }
  .panel-status-badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    padding: 3px 8px;
    border-radius: 12px;
  }

  /* ─── Panel Tabs ─── */
  .panel-tabs {
    display: flex;
    border-bottom: 1px solid #21262d;
  }
  .panel-tab {
    flex: 1;
    padding: 10px;
    text-align: center;
    font-size: 12px;
    font-weight: 500;
    color: #8b949e;
    background: none;
    border: none;
    cursor: pointer;
    transition: all 0.2s;
    border-bottom: 2px solid transparent;
    font-family: inherit;
  }
  .panel-tab.active {
    color: #e6edf3;
    border-bottom-color: #1944F1;
  }
  .panel-tab:hover:not(.active) { color: #c9d1d9; }

  .panel-tab-content { display: none; }
  .panel-tab-content.active { display: block; }

  .panel-section {
    padding: 14px 20px;
    border-bottom: 1px solid #21262d;
  }
  .panel-section-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #8b949e;
    margin-bottom: 8px;
  }
  .panel-description {
    font-size: 13px;
    line-height: 1.6;
    color: #c9d1d9;
  }

  .panel-edge {
    padding: 8px 12px;
    background: #0d1117;
    border-radius: 8px;
    margin-bottom: 6px;
    border: 1px solid #21262d;
  }
  .panel-edge-target {
    font-size: 12px;
    font-weight: 500;
    color: #58a6ff;
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
  }
  .panel-edge-condition {
    font-size: 11px;
    color: #8b949e;
    margin-top: 3px;
    line-height: 1.4;
  }

  .panel-trigger {
    display: inline-block;
    font-size: 11px;
    padding: 3px 10px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 12px;
    margin: 2px 3px 2px 0;
    color: #c9d1d9;
  }

  /* ─── Content Preview ─── */
  .content-preview {
    padding: 16px 20px;
    font-size: 13px;
    line-height: 1.7;
    color: #c9d1d9;
  }
  .content-preview .cp-heading {
    font-weight: 700;
    color: #e6edf3;
    margin: 14px 0 6px;
  }
  .content-preview .cp-h1 { font-size: 18px; }
  .content-preview .cp-h2 { font-size: 15px; }
  .content-preview .cp-h3 { font-size: 13px; }
  .content-preview .cp-list-item {
    padding-left: 16px;
    position: relative;
  }
  .content-preview .cp-list-item::before {
    content: '\2022';
    position: absolute;
    left: 4px;
    color: #484f58;
  }
  .content-preview .cp-code-block {
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 6px;
    padding: 10px 14px;
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 12px;
    margin: 8px 0;
    white-space: pre-wrap;
    overflow-x: auto;
    color: #e6edf3;
  }
  .content-preview .cp-comment {
    color: #484f58;
    font-style: italic;
    font-size: 12px;
  }
  .content-preview .cp-paragraph {
    margin: 6px 0;
  }
  .content-preview .cp-table-row {
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 11px;
    color: #8b949e;
    padding: 2px 0;
  }

  /* ─── Navigation Narration ─── */
  #nav-narration {
    position: fixed;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 110;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 10px;
    padding: 14px 20px;
    max-width: 500px;
    min-width: 300px;
    font-size: 13px;
    color: #c9d1d9;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    display: none;
    transition: opacity 0.3s;
  }
  #nav-narration.visible { display: block; }
  .nav-step {
    padding: 4px 0;
    opacity: 0.4;
    transition: opacity 0.3s;
  }
  .nav-step.active { opacity: 1; color: #e6edf3; }
  .nav-step.done { opacity: 0.7; color: #2ea043; }
  .nav-step-arrow { color: #484f58; margin-right: 6px; }
  .nav-no-match { color: #f85149; }

  /* ─── Empty State ─── */
  #empty-state {
    display: none;
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    z-index: 50;
  }
  #empty-state h2 { font-size: 20px; color: #8b949e; font-weight: 500; margin-bottom: 8px; }
  #empty-state p { font-size: 14px; color: #484f58; }

  /* ─── Tooltip ─── */
  #tooltip {
    position: fixed;
    pointer-events: none;
    z-index: 300;
    background: #1c2128;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 12px;
    color: #c9d1d9;
    opacity: 0;
    transition: opacity 0.15s;
    max-width: 280px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  #tooltip.visible { opacity: 1; }
  .tooltip-label {
    font-size: 10px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* ─── Scrollbar ─── */
  #side-panel::-webkit-scrollbar { width: 6px; }
  #side-panel::-webkit-scrollbar-track { background: transparent; }
  #side-panel::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
  #side-panel::-webkit-scrollbar-thumb:hover { background: #484f58; }
</style>
</head>
<body>

<div id="progress-bar-container">
  <div id="progress-bar-fill"></div>
</div>
<div id="progress-label"></div>

<div id="header">
  <h1><span>mex</span></h1>
  <p>scaffold visualizer</p>
</div>

<div id="nav-simulator">
  <input type="text" id="nav-input" placeholder="Simulate: what task are you doing?" spellcheck="false" />
</div>

<div id="layout-toggle">
  <button class="layout-btn active" data-layout="force">Force</button>
  <button class="layout-btn" data-layout="clustered">Clustered</button>
</div>

<div id="legend">
  <div class="legend-item"><div class="legend-dot" style="background:#f0a500"></div> Root</div>
  <div class="legend-item"><div class="legend-dot" style="background:#1944F1"></div> Context</div>
  <div class="legend-item"><div class="legend-dot" style="background:#2ea043"></div> Patterns</div>
  <div class="legend-item" style="margin-left:12px"><div class="legend-ring" style="border-color:#2ea043"></div> Populated</div>
  <div class="legend-item"><div class="legend-ring" style="border-color:#f0a500"></div> Partial</div>
  <div class="legend-item"><div class="legend-ring" style="border-color:#f85149"></div> Empty</div>
</div>

<div id="stats-bar">
  <div class="stat-item">Nodes <span class="stat-value" id="stat-nodes">0</span></div>
  <div class="stat-item">Edges <span class="stat-value" id="stat-edges">0</span></div>
  <div class="stat-item">Completion <span class="stat-value" id="stat-completion">0%</span></div>
  <div class="stat-item">Undetermined <span class="stat-value" id="stat-undetermined">0</span></div>
</div>

<div id="empty-state">
  <h2>No edges found</h2>
  <p>Run setup first to populate the scaffold</p>
</div>

<div id="tooltip"></div>

<div id="nav-narration"></div>

<div id="side-panel">
  <div class="panel-header">
    <div>
      <div class="panel-title" id="panel-title"></div>
      <div class="panel-filename" id="panel-filename"></div>
      <div class="panel-badges">
        <div class="panel-type-badge" id="panel-badge"></div>
        <div class="panel-status-badge" id="panel-status-badge"></div>
      </div>
    </div>
    <button class="panel-close" id="panel-close">&times;</button>
  </div>
  <div class="panel-tabs">
    <button class="panel-tab active" data-tab="info">Info</button>
    <button class="panel-tab" data-tab="content">Content</button>
  </div>
  <div id="panel-tab-info" class="panel-tab-content active"></div>
  <div id="panel-tab-content" class="panel-tab-content"></div>
</div>

<canvas id="particle-canvas"></canvas>
<svg id="graph"></svg>

<script>
const COLORS = {
  root: '#f0a500',
  context: '#1944F1',
  pattern: '#2ea043',
  other: '#8b949e'
};

const GLOW_COLORS = {
  root: 'rgba(240, 165, 0, 0.6)',
  context: 'rgba(25, 68, 241, 0.5)',
  pattern: 'rgba(46, 160, 67, 0.5)',
  other: 'rgba(139, 148, 158, 0.3)'
};

const STATUS_COLORS = {
  populated: '#2ea043',
  partial: '#f0a500',
  empty: '#f85149'
};

const SIZE = {
  'ROUTER.md': 28,
  'AGENTS.md': 20,
  'SETUP.md': 18,
  'SYNC.md': 18,
  context: 16,
  pattern: 12,
  other: 10
};

function nodeSize(d) {
  if (SIZE[d.filename]) return SIZE[d.filename];
  return SIZE[d.type] || SIZE.other;
}

function nodeColor(d) { return COLORS[d.type] || COLORS.other; }
function glowColor(d) { return GLOW_COLORS[d.type] || GLOW_COLORS.other; }
function statusColor(d) { return STATUS_COLORS[d.status] || STATUS_COLORS.empty; }

// ─── Global state ───
let graphData = null;
let simulation = null;
let currentLayout = 'force';
let nodeG = null;
let link = null;
let linkHover = null;
let particleCtx = null;
let particles = [];
let svgTransform = null;
let gGroup = null;
let navAnimating = false;

fetch('/api/graph')
  .then(r => r.json())
  .then(data => {
    graphData = data;
    updateStats(data);
    updateProgressBar(data);
    render(data);
    initParticles(data);
    initNavSimulator(data);
  });

function updateStats(data) {
  const { nodes, edges } = data;
  document.getElementById('stat-nodes').textContent = nodes.length;
  document.getElementById('stat-edges').textContent = edges.length;

  const contentFiles = nodes.filter(n => n.type !== 'root' || n.filename === 'ROUTER.md');
  const populated = nodes.filter(n => n.status === 'populated').length;
  const pct = nodes.length > 0 ? Math.round((populated / nodes.length) * 100) : 0;
  document.getElementById('stat-completion').textContent = pct + '%';

  const undetermined = nodes.filter(n => n.status === 'partial' || n.status === 'empty').length;
  document.getElementById('stat-undetermined').textContent = undetermined;
}

function updateProgressBar(data) {
  const { nodes } = data;
  const populated = nodes.filter(n => n.status === 'populated').length;
  const pct = nodes.length > 0 ? Math.round((populated / nodes.length) * 100) : 0;

  const fill = document.getElementById('progress-bar-fill');
  fill.style.width = pct + '%';
  if (pct < 100) {
    fill.classList.add('pulsing');
  } else {
    fill.classList.remove('pulsing');
  }
  document.getElementById('progress-label').textContent = 'Scaffold completion: ' + pct + '%';
}

function render(data) {
  const { nodes, edges } = data;

  if (edges.length === 0) {
    document.getElementById('empty-state').style.display = 'block';
    if (nodes.length === 0) return;
  }

  const width = window.innerWidth;
  const height = window.innerHeight;

  const svg = d3.select('#graph')
    .attr('width', width)
    .attr('height', height);

  // ─── Defs ───
  const defs = svg.append('defs');

  // Glow filter for edges
  const glowFilter = defs.append('filter')
    .attr('id', 'glow')
    .attr('x', '-50%').attr('y', '-50%')
    .attr('width', '200%').attr('height', '200%');
  glowFilter.append('feGaussianBlur')
    .attr('stdDeviation', '3')
    .attr('result', 'blur');
  glowFilter.append('feMerge')
    .selectAll('feMergeNode')
    .data(['blur', 'SourceGraphic'])
    .enter().append('feMergeNode')
    .attr('in', d => d);

  // Node glow filter
  const nodeGlowF = defs.append('filter')
    .attr('id', 'node-glow')
    .attr('x', '-100%').attr('y', '-100%')
    .attr('width', '300%').attr('height', '300%');
  nodeGlowF.append('feGaussianBlur')
    .attr('stdDeviation', '6')
    .attr('result', 'blur');
  nodeGlowF.append('feMerge')
    .selectAll('feMergeNode')
    .data(['blur', 'SourceGraphic'])
    .enter().append('feMergeNode')
    .attr('in', d => d);

  // Arrow markers
  defs.append('marker')
    .attr('id', 'arrow')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 20).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-4L8,0L0,4')
    .attr('fill', '#30363d');

  defs.append('marker')
    .attr('id', 'arrow-highlight')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 20).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-4L8,0L0,4')
    .attr('fill', '#58a6ff');

  defs.append('marker')
    .attr('id', 'arrow-nav')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 20).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-4L8,0L0,4')
    .attr('fill', '#f0a500');

  const g = svg.append('g');
  gGroup = g;

  // Zoom
  const zoom = d3.zoom()
    .scaleExtent([0.2, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
      svgTransform = event.transform;
    });
  svg.call(zoom);

  svgTransform = d3.zoomIdentity.translate(width / 2, height / 2).scale(0.9);
  svg.call(zoom.transform, svgTransform);

  // Adjacency map for hover
  const adjacency = new Map();
  nodes.forEach(n => adjacency.set(n.id, new Set()));
  edges.forEach(e => {
    const sid = typeof e.source === 'object' ? e.source.id : e.source;
    const tid = typeof e.target === 'object' ? e.target.id : e.target;
    adjacency.get(sid)?.add(tid);
    adjacency.get(tid)?.add(sid);
  });

  // ─── Force simulation ───
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(140).strength(0.4))
    .force('charge', d3.forceManyBody().strength(-600).distanceMax(500))
    .force('center', d3.forceCenter(0, 0))
    .force('collision', d3.forceCollide().radius(d => nodeSize(d) + 20))
    .force('x', d3.forceX(0).strength(0.03))
    .force('y', d3.forceY(0).strength(0.03))
    .alphaDecay(0.015)
    .velocityDecay(0.4);

  // ─── Draw edges ───
  const linkGroup = g.append('g').attr('class', 'links');
  link = linkGroup.selectAll('line')
    .data(edges)
    .enter().append('line')
    .attr('stroke', '#30363d')
    .attr('stroke-width', 1.5)
    .attr('stroke-opacity', 0.6)
    .attr('marker-end', 'url(#arrow)');

  linkHover = linkGroup.selectAll('.link-hover')
    .data(edges)
    .enter().append('line')
    .attr('class', 'link-hover')
    .attr('stroke', 'transparent')
    .attr('stroke-width', 12)
    .on('mouseenter', (event, d) => {
      if (d.condition) {
        const tooltip = document.getElementById('tooltip');
        tooltip.innerHTML = '<div class="tooltip-label">Edge condition</div>' + escapeHtml(d.condition);
        tooltip.classList.add('visible');
        tooltip.style.left = event.clientX + 12 + 'px';
        tooltip.style.top = event.clientY - 10 + 'px';
      }
    })
    .on('mousemove', (event) => {
      const tooltip = document.getElementById('tooltip');
      tooltip.style.left = event.clientX + 12 + 'px';
      tooltip.style.top = event.clientY - 10 + 'px';
    })
    .on('mouseleave', () => {
      document.getElementById('tooltip').classList.remove('visible');
    });

  // ─── Draw nodes ───
  const nodeGroup = g.append('g').attr('class', 'nodes');

  nodeG = nodeGroup.selectAll('g')
    .data(nodes)
    .enter().append('g')
    .attr('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.1).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x; d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
      })
    );

  // Outer glow
  nodeG.append('circle')
    .attr('class', 'node-glow')
    .attr('r', d => nodeSize(d) + 4)
    .attr('fill', d => glowColor(d))
    .attr('filter', 'url(#node-glow)')
    .attr('opacity', 0.4);

  // Status ring
  nodeG.append('circle')
    .attr('class', 'node-status-ring')
    .attr('r', d => nodeSize(d) + 3)
    .attr('fill', 'none')
    .attr('stroke', d => statusColor(d))
    .attr('stroke-width', 2)
    .attr('stroke-opacity', 0.7)
    .attr('stroke-dasharray', d => d.status === 'empty' ? '3,3' : d.status === 'partial' ? '6,3' : 'none');

  // Main circle
  nodeG.append('circle')
    .attr('class', 'node-circle')
    .attr('r', d => nodeSize(d))
    .attr('fill', d => nodeColor(d))
    .attr('stroke', d => nodeColor(d))
    .attr('stroke-width', 2)
    .attr('stroke-opacity', 0.8)
    .attr('fill-opacity', 0.85);

  // Inner highlight
  nodeG.append('circle')
    .attr('class', 'node-inner')
    .attr('r', d => nodeSize(d) * 0.4)
    .attr('fill', 'rgba(255,255,255,0.15)');

  // Labels
  nodeG.append('text')
    .attr('class', 'node-label')
    .attr('dy', d => nodeSize(d) + 16)
    .attr('text-anchor', 'middle')
    .attr('fill', '#c9d1d9')
    .attr('font-size', d => d.type === 'root' ? '12px' : '11px')
    .attr('font-weight', d => d.type === 'root' ? '600' : '400')
    .style('text-shadow', '0 1px 3px rgba(0,0,0,0.6)')
    .text(d => {
      const parts = d.filename.split('/');
      return parts[parts.length - 1].replace('.md', '');
    });

  // Folder prefix
  nodeG.filter(d => d.type !== 'root')
    .append('text')
    .attr('class', 'node-folder')
    .attr('dy', d => nodeSize(d) + 28)
    .attr('text-anchor', 'middle')
    .attr('fill', '#484f58')
    .attr('font-size', '9px')
    .style('text-shadow', '0 1px 2px rgba(0,0,0,0.5)')
    .text(d => {
      const parts = d.filename.split('/');
      return parts.length > 1 ? parts[0] + '/' : '';
    });

  // ─── Hover interactions ───
  nodeG.on('mouseenter', (event, d) => {
    if (navAnimating) return;
    const connected = adjacency.get(d.id) || new Set();

    nodeG.transition().duration(200)
      .attr('opacity', n => (n.id === d.id || connected.has(n.id)) ? 1 : 0.15);

    link.transition().duration(200)
      .attr('stroke', e => {
        const sid = typeof e.source === 'object' ? e.source.id : e.source;
        const tid = typeof e.target === 'object' ? e.target.id : e.target;
        return (sid === d.id || tid === d.id) ? '#58a6ff' : '#30363d';
      })
      .attr('stroke-opacity', e => {
        const sid = typeof e.source === 'object' ? e.source.id : e.source;
        const tid = typeof e.target === 'object' ? e.target.id : e.target;
        return (sid === d.id || tid === d.id) ? 1 : 0.1;
      })
      .attr('stroke-width', e => {
        const sid = typeof e.source === 'object' ? e.source.id : e.source;
        const tid = typeof e.target === 'object' ? e.target.id : e.target;
        return (sid === d.id || tid === d.id) ? 2.5 : 1.5;
      })
      .attr('marker-end', e => {
        const sid = typeof e.source === 'object' ? e.source.id : e.source;
        const tid = typeof e.target === 'object' ? e.target.id : e.target;
        return (sid === d.id || tid === d.id) ? 'url(#arrow-highlight)' : 'url(#arrow)';
      });

    d3.select(event.currentTarget).select('.node-circle')
      .transition().duration(200).attr('r', nodeSize(d) * 1.2);
    d3.select(event.currentTarget).select('.node-glow')
      .transition().duration(200).attr('r', nodeSize(d) * 1.2 + 6).attr('opacity', 0.7);
    d3.select(event.currentTarget).select('.node-status-ring')
      .transition().duration(200).attr('r', nodeSize(d) * 1.2 + 4);
    d3.select(event.currentTarget).select('.node-inner')
      .transition().duration(200).attr('r', nodeSize(d) * 0.5);
  });

  nodeG.on('mouseleave', (event, d) => {
    if (navAnimating) return;
    nodeG.transition().duration(300).attr('opacity', 1);
    link.transition().duration(300)
      .attr('stroke', '#30363d')
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', 1.5)
      .attr('marker-end', 'url(#arrow)');

    d3.select(event.currentTarget).select('.node-circle')
      .transition().duration(300).attr('r', nodeSize(d));
    d3.select(event.currentTarget).select('.node-glow')
      .transition().duration(300).attr('r', nodeSize(d) + 4).attr('opacity', 0.4);
    d3.select(event.currentTarget).select('.node-status-ring')
      .transition().duration(300).attr('r', nodeSize(d) + 3);
    d3.select(event.currentTarget).select('.node-inner')
      .transition().duration(300).attr('r', nodeSize(d) * 0.4);
  });

  // Click to show side panel
  nodeG.on('click', (event, d) => {
    event.stopPropagation();
    showPanel(d, edges);
  });

  svg.on('click', () => {
    document.getElementById('side-panel').classList.remove('open');
  });

  document.getElementById('panel-close').addEventListener('click', () => {
    document.getElementById('side-panel').classList.remove('open');
  });

  // ─── Panel tabs ───
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel-tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // ─── Layout toggle ───
  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      switchLayout(btn.dataset.layout, nodes, width, height);
    });
  });

  // Simulation tick
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    linkHover
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    nodeG.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

// ─── Layout switching ───
function switchLayout(layout, nodes, width, height) {
  currentLayout = layout;

  if (layout === 'clustered') {
    // Disable forces, position by cluster
    simulation.force('center', null);
    simulation.force('charge', d3.forceManyBody().strength(-200).distanceMax(300));
    simulation.force('x', d3.forceX(d => {
      if (d.type === 'root') return 0;
      if (d.type === 'context') return -250;
      if (d.type === 'pattern') return 250;
      return 0;
    }).strength(0.3));
    simulation.force('y', d3.forceY(d => {
      if (d.type === 'root') return 0;
      return 0;
    }).strength(0.1));
  } else {
    simulation.force('center', d3.forceCenter(0, 0));
    simulation.force('charge', d3.forceManyBody().strength(-600).distanceMax(500));
    simulation.force('x', d3.forceX(0).strength(0.03));
    simulation.force('y', d3.forceY(0).strength(0.03));
  }

  simulation.alpha(0.6).restart();
}

// ─── Side Panel ───
function showPanel(d, allEdges) {
  const panel = document.getElementById('side-panel');
  document.getElementById('panel-title').textContent = d.name || d.filename;
  document.getElementById('panel-filename').textContent = d.filename;

  // Type badge
  const badgeColors = {
    root: { bg: 'rgba(240,165,0,0.15)', color: '#f0a500' },
    context: { bg: 'rgba(25,68,241,0.15)', color: '#4d7aff' },
    pattern: { bg: 'rgba(46,160,67,0.15)', color: '#2ea043' }
  };
  const bc = badgeColors[d.type] || { bg: 'rgba(139,148,158,0.15)', color: '#8b949e' };
  const badgeEl = document.getElementById('panel-badge');
  badgeEl.textContent = d.type;
  badgeEl.style.background = bc.bg;
  badgeEl.style.color = bc.color;

  // Status badge
  const statusBadgeEl = document.getElementById('panel-status-badge');
  const sc = STATUS_COLORS[d.status] || '#8b949e';
  statusBadgeEl.textContent = d.status;
  statusBadgeEl.style.background = sc + '22';
  statusBadgeEl.style.color = sc;

  // ─── Info tab ───
  let html = '';

  if (d.description) {
    html += '<div class="panel-section">';
    html += '<div class="panel-section-title">Description</div>';
    html += '<div class="panel-description">' + escapeHtml(d.description) + '</div>';
    html += '</div>';
  }

  const outEdges = allEdges.filter(e => {
    const sid = typeof e.source === 'object' ? e.source.id : e.source;
    return sid === d.id;
  });
  const inEdges = allEdges.filter(e => {
    const tid = typeof e.target === 'object' ? e.target.id : e.target;
    return tid === d.id;
  });

  if (outEdges.length > 0) {
    html += '<div class="panel-section">';
    html += '<div class="panel-section-title">Outgoing edges (' + outEdges.length + ')</div>';
    outEdges.forEach(e => {
      const tid = typeof e.target === 'object' ? e.target.id : e.target;
      html += '<div class="panel-edge">';
      html += '<div class="panel-edge-target">' + escapeHtml(tid) + '</div>';
      if (e.condition) html += '<div class="panel-edge-condition">' + escapeHtml(e.condition) + '</div>';
      html += '</div>';
    });
    html += '</div>';
  }

  if (inEdges.length > 0) {
    html += '<div class="panel-section">';
    html += '<div class="panel-section-title">Incoming edges (' + inEdges.length + ')</div>';
    inEdges.forEach(e => {
      const sid = typeof e.source === 'object' ? e.source.id : e.source;
      html += '<div class="panel-edge">';
      html += '<div class="panel-edge-target">' + escapeHtml(sid) + '</div>';
      if (e.condition) html += '<div class="panel-edge-condition">' + escapeHtml(e.condition) + '</div>';
      html += '</div>';
    });
    html += '</div>';
  }

  if (d.triggers && d.triggers.length > 0) {
    html += '<div class="panel-section">';
    html += '<div class="panel-section-title">Triggers</div>';
    html += '<div>';
    d.triggers.forEach(t => {
      html += '<span class="panel-trigger">' + escapeHtml(t) + '</span>';
    });
    html += '</div></div>';
  }

  if (d.last_updated && d.last_updated !== '[YYYY-MM-DD]') {
    html += '<div class="panel-section">';
    html += '<div class="panel-section-title">Last updated</div>';
    html += '<div class="panel-description">' + escapeHtml(d.last_updated) + '</div>';
    html += '</div>';
  }

  document.getElementById('panel-tab-info').innerHTML = html;

  // ─── Content tab ───
  const contentHtml = renderMarkdownContent(d.content || '');
  document.getElementById('panel-tab-content').innerHTML = '<div class="content-preview">' + contentHtml + '</div>';

  // Reset to Info tab
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel-tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('.panel-tab[data-tab="info"]').classList.add('active');
  document.getElementById('panel-tab-info').classList.add('active');

  panel.classList.add('open');
}

function renderMarkdownContent(text) {
  if (!text || !text.trim()) return '<div style="color:#484f58;padding:20px;">No content</div>';

  const lines = text.split('\n');
  let html = '';
  let inCodeBlock = false;
  let codeContent = '';
  let inComment = false;
  let commentContent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code blocks
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        html += '<div class="cp-code-block">' + escapeHtml(codeContent.trim()) + '</div>';
        codeContent = '';
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeContent += line + '\n';
      continue;
    }

    // Multi-line comments
    if (!inComment && trimmed.startsWith('<!--')) {
      if (trimmed.includes('-->')) {
        // Single-line comment
        html += '<div class="cp-comment">' + escapeHtml(trimmed) + '</div>';
      } else {
        inComment = true;
        commentContent = trimmed;
      }
      continue;
    }
    if (inComment) {
      commentContent += '\n' + line;
      if (trimmed.includes('-->')) {
        html += '<div class="cp-comment">' + escapeHtml(commentContent.trim()) + '</div>';
        commentContent = '';
        inComment = false;
      }
      continue;
    }

    // Headings
    if (trimmed.startsWith('### ')) {
      html += '<div class="cp-heading cp-h3">' + escapeHtml(trimmed.slice(4)) + '</div>';
    } else if (trimmed.startsWith('## ')) {
      html += '<div class="cp-heading cp-h2">' + escapeHtml(trimmed.slice(3)) + '</div>';
    } else if (trimmed.startsWith('# ')) {
      html += '<div class="cp-heading cp-h1">' + escapeHtml(trimmed.slice(2)) + '</div>';
    }
    // List items
    else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      html += '<div class="cp-list-item">' + escapeHtml(trimmed.slice(2)) + '</div>';
    }
    // Numbered list
    else if (/^\d+\.\s/.test(trimmed)) {
      html += '<div class="cp-list-item">' + escapeHtml(trimmed) + '</div>';
    }
    // Table rows
    else if (trimmed.startsWith('|')) {
      html += '<div class="cp-table-row">' + escapeHtml(trimmed) + '</div>';
    }
    // Empty line
    else if (!trimmed) {
      html += '<div style="height:8px"></div>';
    }
    // Normal text
    else {
      html += '<div class="cp-paragraph">' + escapeHtml(trimmed) + '</div>';
    }
  }

  return html || '<div style="color:#484f58;padding:20px;">No content</div>';
}

// ─── Particle System ───
function initParticles(data) {
  const canvas = document.getElementById('particle-canvas');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  particleCtx = canvas.getContext('2d');

  // Create 1-2 particles per edge
  data.edges.forEach((edge, i) => {
    const count = 1 + (i % 2);
    for (let j = 0; j < count; j++) {
      particles.push({
        edge: edge,
        t: Math.random(),
        speed: 0.002 + Math.random() * 0.002
      });
    }
  });

  requestAnimationFrame(animateParticles);
}

function animateParticles() {
  if (!particleCtx || !svgTransform) {
    requestAnimationFrame(animateParticles);
    return;
  }

  const canvas = particleCtx.canvas;
  particleCtx.clearRect(0, 0, canvas.width, canvas.height);

  particles.forEach(p => {
    p.t += p.speed;
    if (p.t > 1) p.t -= 1;

    const src = p.edge.source;
    const tgt = p.edge.target;
    if (!src || !tgt || src.x == null || tgt.x == null) return;

    // Transform coordinates through SVG transform
    const sx = svgTransform.applyX(src.x);
    const sy = svgTransform.applyY(src.y);
    const tx = svgTransform.applyX(tgt.x);
    const ty = svgTransform.applyY(tgt.y);

    const x = sx + (tx - sx) * p.t;
    const y = sy + (ty - sy) * p.t;

    // Glow
    const gradient = particleCtx.createRadialGradient(x, y, 0, x, y, 6);
    gradient.addColorStop(0, 'rgba(88, 166, 255, 0.6)');
    gradient.addColorStop(1, 'rgba(88, 166, 255, 0)');
    particleCtx.fillStyle = gradient;
    particleCtx.beginPath();
    particleCtx.arc(x, y, 6, 0, Math.PI * 2);
    particleCtx.fill();

    // Core dot
    particleCtx.fillStyle = 'rgba(88, 166, 255, 0.9)';
    particleCtx.beginPath();
    particleCtx.arc(x, y, 1.5, 0, Math.PI * 2);
    particleCtx.fill();
  });

  requestAnimationFrame(animateParticles);
}

// ─── Navigation Simulator ───
function initNavSimulator(data) {
  const input = document.getElementById('nav-input');
  let debounceTimer = null;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const query = input.value.trim();
      if (query && !navAnimating) {
        runNavSimulation(query, data);
      }
    }
  });
}

function runNavSimulation(query, data) {
  navAnimating = true;
  const narration = document.getElementById('nav-narration');
  const queryLower = query.toLowerCase();
  const keywords = queryLower.split(/\s+/);

  // Step 1: always start at ROUTER.md
  const steps = [{ nodeId: 'ROUTER.md', message: 'Reading ROUTER.md...' }];

  // Step 2: check routing table
  let routeMatch = null;
  if (data.routing_table) {
    for (const route of data.routing_table) {
      const taskLower = route.task.toLowerCase();
      if (keywords.some(kw => taskLower.includes(kw)) || taskLower.includes(queryLower)) {
        routeMatch = route.target;
        break;
      }
    }
  }

  // Step 3: check node triggers
  let triggerMatch = null;
  for (const node of data.nodes) {
    if (node.triggers && node.triggers.length > 0) {
      for (const trigger of node.triggers) {
        const trigLower = trigger.toLowerCase();
        if (keywords.some(kw => trigLower.includes(kw)) || trigLower.includes(queryLower)) {
          triggerMatch = node.id;
          break;
        }
      }
      if (triggerMatch) break;
    }
  }

  // Step 4: check edge conditions from ROUTER.md
  let conditionMatch = null;
  for (const edge of data.edges) {
    const sid = typeof edge.source === 'object' ? edge.source.id : edge.source;
    if (sid === 'ROUTER.md' && edge.condition) {
      const condLower = edge.condition.toLowerCase();
      if (keywords.some(kw => condLower.includes(kw))) {
        const tid = typeof edge.target === 'object' ? edge.target.id : edge.target;
        conditionMatch = tid;
        break;
      }
    }
  }

  // Build the full navigation path
  // Step 2: find the context file from routing table or edge conditions
  const contextTarget = routeMatch || conditionMatch;

  if (!contextTarget && !triggerMatch) {
    steps.push({ nodeId: null, message: 'No matching route found for "' + query + '"' });
  } else if (contextTarget) {
    // Standard path: ROUTER → context file → INDEX → pattern
    steps.push({ nodeId: contextTarget, message: 'Loading ' + contextTarget + '...' });

    // Step 3: check conventions too if we're writing code and didn't already route there
    if (contextTarget !== 'context/conventions.md' &&
        keywords.some(kw => ['write', 'add', 'create', 'build', 'implement', 'new', 'endpoint', 'route', 'component', 'feature'].includes(kw))) {
      steps.push({ nodeId: 'context/conventions.md', message: 'Loading conventions for code writing...' });
    }

    // Step 4: always check pattern index
    steps.push({ nodeId: 'patterns/INDEX.md', message: 'Checking pattern index...' });

    // Step 5: find a matching pattern file
    let matchedPattern = null;
    for (const node of data.nodes) {
      if (node.type === 'pattern' && node.id !== 'patterns/INDEX.md' && node.id !== 'patterns/README.md') {
        const nameMatch = keywords.some(kw => node.id.toLowerCase().includes(kw));
        const trigMatch = node.triggers && node.triggers.some(t => keywords.some(kw => t.toLowerCase().includes(kw)));
        const descMatch = node.description && keywords.some(kw => node.description.toLowerCase().includes(kw));
        if (nameMatch || trigMatch || descMatch) {
          matchedPattern = node.id;
          break;
        }
      }
    }

    if (matchedPattern) {
      steps.push({ nodeId: matchedPattern, message: 'Found pattern: ' + matchedPattern + ' — following it' });
    } else {
      steps.push({ nodeId: 'patterns/INDEX.md', message: 'No specific pattern found — agent proceeds with context' });
      // Remove duplicate INDEX step
      steps.splice(steps.length - 2, 1);
    }
  } else if (triggerMatch) {
    // Direct trigger match (e.g. typed a keyword that matches a specific file)
    // Still go through the proper chain
    const trigNode = data.nodes.find(n => n.id === triggerMatch);
    if (trigNode && trigNode.type === 'context') {
      steps.push({ nodeId: triggerMatch, message: 'Loading ' + triggerMatch + ' (trigger match)...' });
      steps.push({ nodeId: 'patterns/INDEX.md', message: 'Checking pattern index...' });
    } else if (trigNode && trigNode.type === 'pattern') {
      // Pattern trigger — still load context first
      steps.push({ nodeId: 'context/conventions.md', message: 'Loading conventions first...' });
      steps.push({ nodeId: 'patterns/INDEX.md', message: 'Checking pattern index...' });
      steps.push({ nodeId: triggerMatch, message: 'Found pattern: ' + triggerMatch + ' — following it' });
    } else {
      steps.push({ nodeId: triggerMatch, message: 'Routing to ' + triggerMatch + '...' });
    }
  }

  // Render narration and animate
  let stepsHtml = steps.map((s, i) =>
    '<div class="nav-step" id="nav-step-' + i + '"><span class="nav-step-arrow">' + (i === 0 ? '>' : '  >') + '</span>' +
    (s.nodeId === null ? '<span class="nav-no-match">' + escapeHtml(s.message) + '</span>' : escapeHtml(s.message)) +
    '</div>'
  ).join('');
  narration.innerHTML = stepsHtml;
  narration.classList.add('visible');

  // Dim all nodes first
  nodeG.transition().duration(300).attr('opacity', 0.15);
  link.transition().duration(300).attr('stroke-opacity', 0.1).attr('stroke', '#30363d').attr('marker-end', 'url(#arrow)');

  // Animate steps
  let stepIndex = 0;
  function animateStep() {
    if (stepIndex >= steps.length) {
      // Done — wait 2s then reset
      setTimeout(() => {
        narration.classList.remove('visible');
        nodeG.transition().duration(500).attr('opacity', 1);
        link.transition().duration(500)
          .attr('stroke', '#30363d')
          .attr('stroke-opacity', 0.6)
          .attr('stroke-width', 1.5)
          .attr('marker-end', 'url(#arrow)');

        // Reset node sizes
        nodeG.each(function(d) {
          d3.select(this).select('.node-circle').transition().duration(300).attr('r', nodeSize(d));
          d3.select(this).select('.node-glow').transition().duration(300).attr('r', nodeSize(d) + 4).attr('opacity', 0.4);
          d3.select(this).select('.node-status-ring').transition().duration(300).attr('r', nodeSize(d) + 3);
        });

        navAnimating = false;
      }, 2000);
      return;
    }

    const step = steps[stepIndex];
    const stepEl = document.getElementById('nav-step-' + stepIndex);
    if (stepEl) stepEl.classList.add('active');

    // Mark previous as done
    if (stepIndex > 0) {
      const prevEl = document.getElementById('nav-step-' + (stepIndex - 1));
      if (prevEl) { prevEl.classList.remove('active'); prevEl.classList.add('done'); }
    }

    if (step.nodeId) {
      // Highlight this node
      nodeG.filter(n => n.id === step.nodeId)
        .transition().duration(300)
        .attr('opacity', 1);

      // Pulse the node
      nodeG.filter(n => n.id === step.nodeId).each(function(d) {
        d3.select(this).select('.node-circle')
          .transition().duration(300).attr('r', nodeSize(d) * 1.4)
          .transition().duration(300).attr('r', nodeSize(d) * 1.1);
        d3.select(this).select('.node-glow')
          .transition().duration(300).attr('r', nodeSize(d) * 1.4 + 8).attr('opacity', 0.8)
          .transition().duration(300).attr('r', nodeSize(d) + 6).attr('opacity', 0.6);
      });

      // Highlight edge from previous node
      if (stepIndex > 0 && steps[stepIndex - 1].nodeId) {
        const prevId = steps[stepIndex - 1].nodeId;
        const curId = step.nodeId;
        link.filter(e => {
          const sid = typeof e.source === 'object' ? e.source.id : e.source;
          const tid = typeof e.target === 'object' ? e.target.id : e.target;
          return (sid === prevId && tid === curId) || (sid === curId && tid === prevId);
        })
        .transition().duration(300)
        .attr('stroke', '#f0a500')
        .attr('stroke-opacity', 1)
        .attr('stroke-width', 3)
        .attr('marker-end', 'url(#arrow-nav)');
      }
    }

    stepIndex++;
    setTimeout(animateStep, 800);
  }

  setTimeout(animateStep, 300);
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Handle resize
window.addEventListener('resize', () => {
  d3.select('#graph')
    .attr('width', window.innerWidth)
    .attr('height', window.innerHeight);

  const canvas = document.getElementById('particle-canvas');
  if (canvas) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
});
</script>
</body>
</html>'''


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path

        if path == '/api/graph':
            data = scan_scaffold()
            payload = json.dumps(data).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        elif path == '/' or path == '/index.html':
            payload = HTML_PAGE.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        else:
            self.send_error(404)

    def log_message(self, format, *args):
        pass


server = HTTPServer(('localhost', PORT), Handler)
server.serve_forever()
PYTHON_SERVER
