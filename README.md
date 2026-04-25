# byzantine-visualizer
This project is a simple visualizer website for the HotStuff Byzantine fault tolerance (BFT) algorithm created as a class project for CPT_S 427 at WSU (Spring 2026). The website can be found [here](https://bft.josephbuchholz.com/). The project is based of the HotStuff BFT algorithm presented in this paper: [arXiv:1803.05069 \[cs.DC\]](https://doi.org/10.48550/arXiv.1803.05069).

The goal of this project was to create a visualization for educational purposes to help others better understand how HotStuff and BFT algorithms in general work. The project consists of two main sections: the algorithm and the front-end visualization. Effort has been put in to separate these two sections as much as possible, thus the algorithm should be usable/readable without the visualization (modulo the cryptography).

The main features include:
- The main visualization consisting of a ring of nodes
- Controls for managing/manipulating the visualization including speed, stepping, and controlling the number of replicas
- A built-in debug log
- Explanation of the current phase/actions
- Dark-light mode toggle
- Other helpful information (current view, state history, etc.)

## Design

The project is split into two parts: the algorithm and the visualization. These can be found in their corresponding folders: `algorithm` and `visual`.

The visualization and frontend was built using React, TailwindCSS, and [Konva.js](https://konvajs.org/). The rest of the project was built using TypeScript and testing was done using Vitest. Docker was used for deployment.

One of the main design challenges was connecting the frontend visualization with the main algorithm without encroaching upon the algorithm's code too much. One of the main decisions was to use a logger inside the algorithm code which logs important events that can then be listened to by the visualization.

Here are some themes that the project relates to:
- Fault tolerance 
- Distributed system security
- Byzantine fault tolerance
- Cloud infrastructure components
- Wireless systems

## Getting Started

Use the `Makefile` recipes to format, lint, test, and run the project.

### Quick Start

Run these commands:

1. `make install`
2. `cd visual`
3. `npm run dev`

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

Frontend Visualization Basics and the UI - Student Joseph Buchholz: I used Co-Pilot as an auto-complete tool as I was coding: only a few lines were generated at the time and all generated lines were reviewed and edited by me. Occasionally, AI was used to debug code.

Portions of this project were generated using Generative AI.