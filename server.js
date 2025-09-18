const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = 8080;
const OLLAMA_URL = 'http://localhost:11434';
const BEARER_TOKEN = process.env.BEARER_TOKEN || 'your-secret-token-here';
const MODEL_NAME = 'mistral:7b';

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

// Warmup function to preload the model
const warmupModel = async () => {
  console.log(`🔥 Starting warmup for ${MODEL_NAME}...`);
  
  try {
    // First, check if Ollama is running
    await axios.get(`${OLLAMA_URL}/api/version`, { timeout: 5000 });
    console.log('✅ Ollama service is running');
    
    // Check if model exists
    const tagsResponse = await axios.get(`${OLLAMA_URL}/api/tags`);
    const modelExists = tagsResponse.data.models.some(model => 
      model.name === MODEL_NAME || model.name.startsWith(MODEL_NAME + ':')
    );
    
    if (!modelExists) {
      console.log(`❌ Model ${MODEL_NAME} not found. Please pull it first with: ollama pull ${MODEL_NAME}`);
      return false;
    }
    
    console.log(`✅ Model ${MODEL_NAME} found`);
    
    // Warmup with a simple generation request
    const warmupPayload = {
      model: MODEL_NAME,
      prompt: "Hi",
      stream: false,
      options: {
        ...getOptimizedParams(),
        max_tokens: 10  // Keep it short for warmup
      }
    };
    
    console.log('🔥 Warming up model (this may take 30-60 seconds)...');
    const startTime = Date.now();
    
    const warmupResponse = await axios.post(
      `${OLLAMA_URL}/api/generate`,
      warmupPayload,
      { timeout: 120000 } // 2 minute timeout for warmup
    );
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`🚀 Model warmup completed in ${duration}s`);
    console.log(`📝 Warmup response: "${warmupResponse.data.response.trim()}"`);
    
    return true;
    
  } catch (error) {
    console.error('❌ Warmup failed:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('💡 Make sure Ollama is running: ollama serve');
    } else if (error.response?.status === 404) {
      console.error(`💡 Model not found. Pull it with: ollama pull ${MODEL_NAME}`);
    }
    return false;
  }
};

// Periodic keepalive to prevent model unloading
const startKeepalive = () => {
  console.log('💓 Starting keepalive ping every 10 minutes');
  
  setInterval(async () => {
    try {
      await axios.post(
        `${OLLAMA_URL}/api/generate`,
        {
          model: MODEL_NAME,
          prompt: "ping",
          stream: false,
          options: { ...getOptimizedParams(), max_tokens: 1 }
        },
        { timeout: 30000 }
      );
      console.log('💓 Keepalive ping successful');
    } catch (error) {
      console.warn('⚠️ Keepalive ping failed:', error.message);
    }
  }, 600000); // 10 minutes
};

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

// Health check endpoint with model status
app.get('/health', async (req, res) => {
  try {
    // Check Ollama status
    const versionResponse = await axios.get(`${OLLAMA_URL}/api/version`, { timeout: 5000 });
    const psResponse = await axios.get(`${OLLAMA_URL}/api/ps`, { timeout: 5000 });
    
    const modelLoaded = psResponse.data.models.some(model => 
      model.name === MODEL_NAME || model.name.startsWith(MODEL_NAME + ':')
    );
    
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      ollama_url: OLLAMA_URL,
      ollama_version: versionResponse.data.version,
      model_loaded: modelLoaded,
      model_name: MODEL_NAME
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Start server with warmup
const startServer = async () => {
  console.log(`🚀 Starting Ollama proxy server...`);
  
  // Start the Express server
  const server = app.listen(PORT, () => {
    console.log(`🚀 Ollama proxy server running on port ${PORT}`);
    console.log(`🎯 Forwarding to Ollama at ${OLLAMA_URL}`);
    console.log(`🔐 Bearer token: ${BEARER_TOKEN}`);
    console.log(`🤖 Target model: ${MODEL_NAME}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  });
  
  // Wait a moment for server to start
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Attempt warmup
  const warmupSuccess = await warmupModel();
  
  if (warmupSuccess) {
    console.log('🎉 Server ready to accept requests!');
    startKeepalive();
  } else {
    console.log('⚠️ Server started but warmup failed. First requests may be slow.');
  }
  
  return server;
};

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Gracefully shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Gracefully shutting down...');
  process.exit(0);
});

// Start the server
startServer().catch(error => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});