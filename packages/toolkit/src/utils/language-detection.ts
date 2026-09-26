/**
 * Detect programming languages from file paths/extensions for syntax highlighting.
 */

const extensionToLanguage: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'jsx', '.ts': 'typescript', '.tsx': 'tsx',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyw': 'python', '.pyi': 'python',
  '.html': 'html', '.htm': 'html', '.xml': 'xml',
  '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.ini': 'ini',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'bash',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.hpp': 'cpp', '.hxx': 'cpp',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.rake': 'ruby',
  '.php': 'php', '.phtml': 'php', '.swift': 'swift', '.mm': 'objectivec',
  '.cs': 'csharp', '.sql': 'sql', '.md': 'markdown', '.markdown': 'markdown',
  '.dockerfile': 'dockerfile', '.makefile': 'makefile', '.mk': 'makefile',
  '.vim': 'vim', '.vimrc': 'vim', '.lua': 'lua',
  '.r': 'r', '.R': 'r', '.scala': 'scala', '.sc': 'scala',
  '.clj': 'clojure', '.cljs': 'clojure', '.cljc': 'clojure',
  '.hs': 'haskell', '.lhs': 'haskell',
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hrl': 'erlang',
  '.ml': 'ocaml', '.mli': 'ocaml', '.fs': 'fsharp', '.fsi': 'fsharp', '.fsx': 'fsharp',
  '.dart': 'dart', '.pl': 'perl', '.pm': 'perl',
  '.groovy': 'groovy', '.gradle': 'groovy',
  '.tex': 'latex', '.latex': 'latex',
  '.m': 'matlab', '.mat': 'matlab',
  '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell',
  '.asm': 'asm', '.s': 'asm',
  '.glsl': 'glsl', '.vert': 'glsl', '.frag': 'glsl',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.prisma': 'prisma', '.sol': 'solidity',
  '.vue': 'vue', '.svelte': 'svelte', '.nix': 'nix', '.jl': 'julia', '.zig': 'zig',
  '.cr': 'crystal', '.nim': 'nim', '.nims': 'nim',
  '.d': 'd', '.di': 'd',
  '.pas': 'pascal', '.pp': 'pascal', '.inc': 'pascal',
  '.f': 'fortran', '.for': 'fortran', '.f90': 'fortran', '.f95': 'fortran',
  '.pro': 'prolog', '.P': 'prolog',
  '.scm': 'scheme', '.ss': 'scheme', '.rkt': 'racket',
  '.lisp': 'lisp', '.lsp': 'lisp', '.cl': 'lisp',
  '.tcl': 'tcl', '.awk': 'awk',
  '.vhd': 'vhdl', '.vhdl': 'vhdl',
  '.v': 'verilog', '.vh': 'verilog', '.sv': 'verilog',
  '.wat': 'wasm', '.wast': 'wasm',
};

const filenameToLanguage: Record<string, string> = {
  'Dockerfile': 'dockerfile', 'Makefile': 'makefile',
  'Rakefile': 'ruby', 'Gemfile': 'ruby',
  '.gitignore': 'gitignore', '.gitattributes': 'gitignore',
  '.npmignore': 'gitignore', '.dockerignore': 'gitignore',
  '.env': 'bash', '.bashrc': 'bash', '.zshrc': 'bash',
  '.bash_profile': 'bash', '.profile': 'bash',
  'nginx.conf': 'nginx', 'httpd.conf': 'apache', '.htaccess': 'apache',
};

export function detectLanguageFromPath(filePath: string): string {
  if (!filePath) return 'text';
  const pathParts = filePath.split('/');
  const filename = pathParts[pathParts.length - 1];
  if (filenameToLanguage[filename]) return filenameToLanguage[filename];
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1 || lastDotIndex === 0) return 'text';
  const extension = filename.slice(lastDotIndex).toLowerCase();
  return extensionToLanguage[extension] || 'text';
}
