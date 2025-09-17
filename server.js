const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = 8080;
const OLLAMA_URL = 'http://localhost:11434';
const BEARER_TOKEN = process.env.BEARER_TOKEN || 'your-secret-token-here';

// Middleware to parse JSON
app.use(express.json({ limit: '50mb' }));

// Bearer token validation middleware
const validateToken = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${BEARER_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Performance optimization parameters for maximum GPU usage
const getOptimizedParams = () => ({
  num_ctx: 4096,        // Max context length
  num_batch: 512,       // Larger batch size for better GPU utilization
  num_gpu: -1,          // Use all available GPUs
  main_gpu: 0,          // Primary GPU
  use_mmap: true,       // Memory mapping for efficiency
  num_thread: 8,        // Optimize thread count
  temperature: 0.7,     // Default creativity
  top_k: 40,           // Top-k sampling
  top_p: 0.9,          // Top-p sampling
  repeat_penalty: 1.1,  // Prevent repetition
  penalize_newline: false
});

// Generic proxy handler
const proxyHandler = async (req, res) => {
  try {
    // Get the original payload
    let payload = req.method === 'GET' ? {} : (req.body || {});
    
    // Only modify payload for POST requests that might have options
    if (req.method === 'POST' && (req.path.includes('/generate') || req.path.includes('/chat'))) {
      // Force streaming to false unless explicitly requested by user
      if (!payload.hasOwnProperty('stream') || payload.stream !== true) {
        payload.stream = false;
      }
      
      // Add performance optimization parameters
      const optimizedParams = getOptimizedParams();
      
      // Merge with existing options, user options take priority
      payload.options = {
        ...optimizedParams,
        ...(payload.options || {})
      };
    }
    
    // Log the request for debugging
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    if (req.method === 'POST' && Object.keys(payload).length > 0) {
      console.log('Modified payload:', JSON.stringify(payload, null, 2));
    }
    
    // Forward to Ollama
    const axiosConfig = {
      method: req.method,
      url: `${OLLAMA_URL}${req.path}`,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 600000 // 10 minute timeout for long generations
    };

    // Add data for POST/PUT requests
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      axiosConfig.data = payload;
    }

    // Handle streaming
    if (payload.stream) {
      axiosConfig.responseType = 'stream';
    }

    const ollamaResponse = await axios(axiosConfig);
    
    // Handle streaming responses
    if (payload.stream) {
      res.setHeader('Content-Type', 'application/json');
      ollamaResponse.data.pipe(res);
    } else {
      res.json(ollamaResponse.data);
    }
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    
    if (error.response) {
      // Ollama returned an error
      res.status(error.response.status).json(error.response.data);
    } else if (error.code === 'ECONNREFUSED') {
      // Ollama is not running
      res.status(503).json({ 
        error: 'Ollama service unavailable',
        message: 'Make sure Ollama is running on localhost:11434'
      });
    } else {
      // Other errors
      res.status(500).json({ 
        error: 'Internal server error',
        message: error.message 
      });
    }
  }
};

// Define specific routes to avoid wildcard issues
app.get('/api/version', validateToken, proxyHandler);
app.get('/api/tags', validateToken, proxyHandler);
app.get('/api/ps', validateToken, proxyHandler);
app.post('/api/generate', validateToken, proxyHandler);
app.post('/api/chat', validateToken, proxyHandler);
app.post('/api/create', validateToken, proxyHandler);
app.post('/api/pull', validateToken, proxyHandler);
app.post('/api/push', validateToken, proxyHandler);
app.post('/api/embed', validateToken, proxyHandler);
app.post('/api/embeddings', validateToken, proxyHandler);
app.post('/api/show', validateToken, proxyHandler);
app.post('/api/copy', validateToken, proxyHandler);
app.delete('/api/delete', validateToken, proxyHandler);
app.head('/api/blobs/:digest', validateToken, proxyHandler);
app.post('/api/blobs/:digest', validateToken, proxyHandler);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    ollama_url: OLLAMA_URL 
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Ollama proxy server running on port ${PORT}`);
  console.log(`🎯 Forwarding to Ollama at ${OLLAMA_URL}`);
  console.log(`🔐 Bearer token: ${BEARER_TOKEN}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
});