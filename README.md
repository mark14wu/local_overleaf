# Local Overleaf

A local LaTeX editor with an Overleaf-like editing and PDF preview experience.

## Setup

```bash
git clone git@github.com:mark14wu/local_overleaf.git
cd local_overleaf
./setup.sh   # install LaTeX and other APT dependencies
```

## Usage

1. Put your LaTeX projects under the `projects/` directory (create it if it doesn't exist):

```bash
mkdir -p projects
# clone or create your LaTeX project
git clone <your-latex-repo> projects/my-project
```

2. Start the server:

```bash
./start.sh
```

3. Open http://localhost:3000, or use the public URL (via Cloudflare Tunnel) printed in the terminal.

## License

AGPL-3.0 (see [LICENSE](LICENSE))
