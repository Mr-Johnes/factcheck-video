# FactCheckVideo

FactCheckVideo is an AI-powered video fact verification platform designed to automatically analyze online videos, extract factual claims, search for supporting evidence, and generate verification verdicts.

The system combines local AI models, NLP pipelines, video processing tools, and web search capabilities to create a privacy-focused fact-checking workflow. The majority of AI processing is performed locally, eliminating the need for expensive external LLM APIs.

---

# Features

- 🎥 Multi-platform video downloading using yt-dlp
- 📝 Local speech-to-text transcription using faster-whisper
- 🧠 AI-powered claim classification:
  - Fact
  - Opinion
  - Uncertain
- 🔍 Automatic extraction of verifiable claims
- 🧩 Context resolution using coreference models
- 🌐 Evidence retrieval using:
  - Serper.dev Google Search API
  - DuckDuckGo fallback search
- 🤖 Local LLM-based verdict generation using Ollama
- 🔒 Privacy-focused architecture with local AI inference
- 💰 Zero LLM API cost using locally hosted models

---

# Project Architecture

FactCheckVideo consists of three major components:


factcheck-video/

├── frontend/
│   └── React frontend application
│
├── backend/
│   ├── Node.js backend server
│   │
│   └── python/
│       ├── nlp_service.py
│       ├── requirements.txt
│       ├── .env.example
│       └── Python NLP microservice
│
└── README.md


---

# Prerequisites

Before running the project, install the following:

## Required Software

- Python *3.12*
- Node.js and npm
- Git
- Ollama

Verify installations:

bash
python --version
node --version
npm --version
git --version


---

# Installation Guide

## 1. Clone the Repository

Copy the repository to your local device:

bash
git clone <repository-link>


Move into the project folder:

bash
cd factcheck-video


All following commands should be executed from this main project directory unless specified otherwise.

---

# 2. Python NLP Microservice Setup

Open the first terminal inside the project root.

Navigate to the Python service:

bash
cd backend/python


---

## Create Python Virtual Environment

Create a virtual environment using Python 3.12:

bash
py -3.12 -m venv venv


Activate the virtual environment:

### Windows

bash
venv\Scripts\activate


After activation, install all Python dependencies:

bash
pip install -r requirements.txt


The Python environment will now contain all required NLP and AI libraries.

---

# 3. Configure Environment Variables

Inside:


backend/python


there is a file:


.env.example


Create a new file:


.env


Copy the contents from .env.example into .env.

Example:

env
SERPER_API_KEY=your_serper_api_key_here


---

## Getting Serper.dev API Key

FactCheckVideo uses Serper.dev for Google search-based evidence retrieval.

Steps:

1. Visit:


https://serper.dev


2. Create an account
3. Generate an API key
4. Paste the key inside:


.env


Example:

env
SERPER_API_KEY=xxxxxxxxxxxxxxxx


Do not upload .env files to GitHub.

---

# 4. Ollama Setup

FactCheckVideo uses Ollama to run the local LLM responsible for generating final verification verdicts.

Install Ollama:


https://ollama.com


---

## Download Llama 3 Model

After installing Ollama, download the required model:

bash
ollama pull llama3


Verify installation:

bash
ollama list


Expected output:


llama3


The Llama 3 model must be available locally before running the application.

---

# Running FactCheckVideo

The complete application requires *four terminals* running simultaneously.

---

# Terminal 1 — Python NLP Microservice

Navigate to:

bash
cd backend/python


Activate the virtual environment:

bash
venv\Scripts\activate


Start the NLP service:

bash
python nlp_service.py


This service handles all AI and NLP operations.

---

# Terminal 2 — Frontend Application

Open another terminal at the project root.

Navigate to frontend:

bash
cd frontend


Install dependencies:

bash
npm install


Start the frontend server:

bash
npm run dev


The React application will start running locally.

---

# Terminal 3 — Backend Server

Open another terminal at the project root.

Navigate to backend:

bash
cd backend


Install dependencies:

bash
npm install


Start the backend server:

bash
npm run dev


---

# Terminal 4 — Ollama Server

Open another terminal and run:

bash
ollama serve


This starts the local LLM inference server required for generating AI verification verdicts.

---

# Python NLP Microservice

The Python microservice contains the complete AI processing pipeline.

## Available API Endpoints

| Endpoint | Description |
|---|---|
| /transcribe | Converts video/audio into text using faster-whisper |
| /classify | Classifies statements into fact, opinion, or uncertain |
| /extract_claims | Detects verifiable claims using NLP models |
| /resolve_context | Resolves references using coreference models |
| /search | Retrieves evidence from search engines |
| /download | Downloads videos using yt-dlp |
| /verdict | Generates final verification results using Ollama |
| /health | Checks service status |

---

# AI Pipeline Details

The Python microservice follows this pipeline:


Video Input
     |
     ↓
Video Download (yt-dlp)
     |
     ↓
Audio Extraction
     |
     ↓
Speech Recognition
(faster-whisper)
     |
     ↓
Claim Detection
(spaCy Dependency Parser)
     |
     ↓
Claim Classification
(spaCy + FLAIR + Rule Engine)
     |
     ↓
Context Resolution
(fastcoref)
     |
     ↓
Evidence Search
(Serper.dev / DuckDuckGo)
     |
     ↓
Verdict Generation
(Ollama Llama 3)


---

# Technology Stack

## Artificial Intelligence / NLP

- Ollama
- Llama 3
- faster-whisper
- spaCy
- FLAIR
- fastcoref

## Backend

- Node.js
- Python
- FastAPI
- yt-dlp

## Frontend

- React
- JSX
- Vite

## External Services

- Serper.dev Search API
- DuckDuckGo Search

---

# Local AI Requirements

The project is designed to run locally.

Required local model:


Llama 3


Installed through:

bash
ollama pull llama3


No external LLM API is required for verdict generation.

---

# Environment Files

The repository contains:


.env.example


which contains the required environment variable structure.

Create:


.env


locally and add your API keys.

Example:


SERPER_API_KEY=your_key_here


The .env file should never be committed.

---

# Troubleshooting

## Python virtual environment not activating

Try:

bash
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser


Then activate again:

bash
venv\Scripts\activate


---

## Ollama model not found

Check installed models:

bash
ollama list


If missing:

bash
ollama pull llama3


---

## Backend or frontend dependency errors

Delete existing dependencies:

Frontend:

bash
rm -rf node_modules
npm install


Backend:

bash
rm -rf node_modules
npm install


---

# Authors

Developed by:

*Abhinav Sah*  
*Raj Aman*

---

# License

This project is developed for research and educational purposes.

## 👥 Contributors

- Abhinav shah 
- Raj Aman
- linkedin - www.linkedin.com/in/raj-aman-2560ab275

## 📄 License

This project is developed for educational and research purposes.
