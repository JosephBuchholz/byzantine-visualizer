# byzantine-visualizer
A visualization of the HotStuff Byzantine fault tolerance algorithm.

See the HotStuff paper: [arXiv:1803.05069 \[cs.DC\]](https://doi.org/10.48550/arXiv.1803.05069).

## Getting Started

Use the `Makefile` recipes to format, lint, test, and run the project.

## Docker

To build the Docker image, run:

```bash
docker build . -t byzantine-visualizer
```

To run the Docker container, run:

```bash
docker run -p 3000:3000 -d byzantine-visualizer
```

## Generative AI Disclosure

Frontend Visualization - Student Joseph Buchholz: I used Co-Pilot as an auto-complete tool as I was coding: only a few lines were generated at the time and all generated lines were reviewed and edited by me. Occasionally, AI was used to debug code.