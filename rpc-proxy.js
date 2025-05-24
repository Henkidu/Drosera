// rpc-proxy.js
const express = require('express');
const fetch = require('node-fetch');

class RPCLoadBalancer {
    constructor() {
        this.providers = [
            {
                name: 'QuickNode',
                url: 'RPC-URL_1',
                rateLimit: 15, // req/sec
                lastRequest: 0,
                errorCount: 0,
                maxErrors: 5,
                priority: 1
            },
            {
                name: 'Alchemy',
                url: 'RPC-URL_2',
                rateLimit: 15, // req/sec
                lastRequest: 0,
                errorCount: 0,
                maxErrors: 5,
                priority: 1
            },
            {
                name: 'Ankr',
                url: 'RPC-URL_3',
                rateLimit: 20,
                lastRequest: 0,
                errorCount: 0,
                maxErrors: 3,
                priority: 3
            },
            {
                name: 'DRPC',
                url: 'RPC-URL_4',
                rateLimit: 15,
                lastRequest: 0,
                errorCount: 0,
                maxErrors: 3,
                priority: 5
            },
            {
                name: 'Public_Panda',
                url: 'RPC-URL_5',
                rateLimit: 15,
                lastRequest: 0,
                errorCount: 0,
                maxErrors: 3,
                priority: 5
            },
            {
                name: 'Public_Thirdweb',
                url: 'RPC-URL_6',
                rateLimit: 15,
                lastRequest: 0,
                errorCount: 0,
                maxErrors: 3,
                priority: 5
            }

        ];
        
        this.requestStats = {
            total: 0,
            successful: 0,
            failed: 0,
            byProvider: {}
        };
        
        // Initialize stats
        this.providers.forEach(p => {
            this.requestStats.byProvider[p.name] = {
                requests: 0,
                successes: 0,
                failures: 0
            };
        });
    }

    selectProvider() {
        const now = Date.now();
        
        // Filtra provider disponibili
        const availableProviders = this.providers
            .filter(p => p.errorCount < p.maxErrors)
            .sort((a, b) => a.priority - b.priority);
        
        if (availableProviders.length === 0) {
            // Reset errori se tutti sono down
            this.providers.forEach(p => p.errorCount = Math.floor(p.errorCount / 2));
            return this.providers[0];
        }
        
        // Trova provider che può fare richiesta ora
        for (let provider of availableProviders) {
            const timeSinceLastRequest = now - provider.lastRequest;
            const minInterval = 1000 / provider.rateLimit;
            
            if (timeSinceLastRequest >= minInterval) {
                return provider;
            }
        }
        
        // Usa quello con attesa minore
        return availableProviders.reduce((best, current) => {
            const bestWait = (1000 / best.rateLimit) - (now - best.lastRequest);
            const currentWait = (1000 / current.rateLimit) - (now - current.lastRequest);
            return currentWait < bestWait ? current : best;
        });
    }

    async makeRequest(jsonrpcPayload, maxRetries = 3) {
        this.requestStats.total++;
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const provider = this.selectProvider();
            const now = Date.now();
            
            // Rate limiting
            const timeSinceLastRequest = now - provider.lastRequest;
            const minInterval = 1000 / provider.rateLimit;
            const delay = Math.max(0, minInterval - timeSinceLastRequest);
            
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            
            try {
                provider.lastRequest = Date.now();
                this.requestStats.byProvider[provider.name].requests++;
                
                const response = await fetch(provider.url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify(jsonrpcPayload),
                    timeout: 30000
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const data = await response.json();
                
                if (data.error && data.error.code === -32007) {
                    // Rate limit specifico, aspetta di più
                    throw new Error(`Rate limit reached on ${provider.name}`);
                }
                
                // Successo
                provider.errorCount = Math.max(0, provider.errorCount - 1);
                this.requestStats.successful++;
                this.requestStats.byProvider[provider.name].successes++;
                
                console.log(`✅ [${provider.name}] ${jsonrpcPayload.method} successful`);
                return data;
                
            } catch (error) {
                provider.errorCount++;
                this.requestStats.byProvider[provider.name].failures++;
                
                console.warn(`❌ [${provider.name}] Attempt ${attempt + 1} failed: ${error.message}`);
                
                // Rate limit error - aspetta di più
                if (error.message.includes('rate limit') || error.message.includes('429')) {
                    await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
                }
                
                if (attempt === maxRetries - 1) {
                    this.requestStats.failed++;
                    throw error;
                }
                
                // Breve pausa prima del retry
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    }

    getHealthStatus() {
        return {
            providers: this.providers.map(p => ({
                name: p.name,
                available: p.errorCount < p.maxErrors,
                errorCount: p.errorCount,
                maxErrors: p.maxErrors,
                rateLimit: p.rateLimit,
                priority: p.priority
            })),
            stats: this.requestStats,
            timestamp: new Date().toISOString()
        };
    }
}

// Express server
const app = express();
const loadBalancer = new RPCLoadBalancer();

app.use(express.json({ limit: '10mb' }));

// CORS per debugging
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Main RPC endpoint
app.post('/', async (req, res) => {
    try {
        const result = await loadBalancer.makeRequest(req.body);
        res.json(result);
    } catch (error) {
        console.error('RPC request failed:', error.message);
        res.status(500).json({
            jsonrpc: '2.0',
            error: {
                code: -32603,
                message: `Internal error: ${error.message}`
            },
            id: req.body.id || null
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json(loadBalancer.getHealthStatus());
});

// Stats endpoint
app.get('/stats', (req, res) => {
    res.json({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        ...loadBalancer.getHealthStatus()
    });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 RPC Load Balancer running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📈 Stats: http://localhost:${PORT}/stats`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    process.exit(0);
});

module.exports = { RPCLoadBalancer };
