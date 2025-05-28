// rpc-proxy.js
const express = require('express');
const fetch = require('node-fetch');

class RPCLoadBalancer {
    constructor() {
        this.providers = [
            {
                name: 'QuickNode',
                url: 'https://green-dry-isle.ethereum-holesky.quiknode.pro/af30a269bd83c815839fe50b377bac4a8ce43a51/',
                rateLimit: 15, // req/sec
                lastRequest: 0,
                errorCount: 0,
                maxErrors: 5,
                priority: 1,
                blockHeight: 0,
                lastHealthCheck: 0
            },
            {
                name: 'Alchemy',
                url: 'https://eth-holesky.g.alchemy.com/v2/BrUxNlh7b1VUw6S_CZevib6nME3P0TSy',
                rateLimit: 15, // req/sec
                lastRequest: 0,
                errorCount: 0,
                maxErrors: 5,
                priority: 1,
                blockHeight: 0,
                lastHealthCheck: 0
            },
            {
                name: 'Ankr',
                url: 'https://rpc.ankr.com/eth/997876ce79161756dceb7ee8f8a546481bd72d81b8fef18e9a801b9eca619608',
                rateLimit: 20,
                lastRequest: 0,
                errorCount: 0,
                maxErrors: 3,
                priority: 3,
                blockHeight: 0,
                lastHealthCheck: 0
            },
            {
                name: 'DRPC',
                url: 'https://lb.drpc.org/ogrpc?network=holesky&dkey=AnD08YOrIEM8uzAD-bjc9DlucRpkOJoR8Kx_brRhIxXF',
                rateLimit: 15,
                lastRequest: 0,
                errorCount: 0,
                maxErrors: 3,
                priority: 5,
                blockHeight: 0,
                lastHealthCheck: 0
            },
            {
                name: 'Public_Panda',
                url: 'https://rpc.holesky.ethpandaops.io',
                rateLimit: 15,
                lastRequest: 0,
                errorCount: 0,
                maxErrors: 3,
                priority: 5,
                blockHeight: 0,
                lastHealthCheck: 0
            },
            {
                name: 'https://holesky.rpc.thirdweb.com',
                url: 'RPC-URL_6',
                rateLimit: 15,
                lastRequest: 0,
                errorCount: 0,
                maxErrors: 3,
                priority: 5,
                blockHeight: 0,
                lastHealthCheck: 0
            }
        ];
        
        this.requestStats = {
            total: 0,
            successful: 0,
            failed: 0,
            byProvider: {}
        };
        
        // Sticky sessions per client IP
        this.clientSessions = new Map();
        this.sessionTimeout = 300000; // 5 minuti
        
        // Cache per richieste identiche
        this.requestCache = new Map();
        this.cacheTimeout = 10000; // 10 secondi
        
        // Initialize stats
        this.providers.forEach(p => {
            this.requestStats.byProvider[p.name] = {
                requests: 0,
                successes: 0,
                failures: 0
            };
        });
        
        // Avvia health check periodico
        this.startHealthCheck();
        
        // Pulisci cache periodicamente
        this.startCacheCleanup();
    }

    // Health check periodico per verificare sincronizzazione
    async startHealthCheck() {
        setInterval(async () => {
            await this.checkAllProvidersHealth();
        }, 30000); // Ogni 30 secondi
    }

    async checkAllProvidersHealth() {
        const promises = this.providers.map(async (provider) => {
            try {
                const blockHeight = await this.getBlockHeight(provider);
                if (blockHeight) {
                    provider.blockHeight = blockHeight;
                    provider.lastHealthCheck = Date.now();
                }
            } catch (error) {
                console.warn(`Health check failed for ${provider.name}: ${error.message}`);
            }
        });
        
        await Promise.allSettled(promises);
        
        // Log dello stato di sincronizzazione
        const heights = this.providers
            .filter(p => p.blockHeight > 0)
            .map(p => ({ name: p.name, height: p.blockHeight }));
        
        if (heights.length > 1) {
            const maxHeight = Math.max(...heights.map(h => h.height));
            const minHeight = Math.min(...heights.map(h => h.height));
            
            if (maxHeight - minHeight > 2) {
                console.warn(`⚠️  Block height discrepancy: ${minHeight} - ${maxHeight}`);
                heights.forEach(h => {
                    if (maxHeight - h.height > 2) {
                        console.warn(`📉 ${h.name} is ${maxHeight - h.height} blocks behind`);
                    }
                });
            }
        }
    }

    async getBlockHeight(provider) {
        const response = await fetch(provider.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'eth_blockNumber',
                params: [],
                id: 1
            }),
            timeout: 5000
        });
        
        const data = await response.json();
        return data.result ? parseInt(data.result, 16) : null;
    }

    // Gestione sessioni sticky per client
    getClientSession(clientIP) {
        const now = Date.now();
        const session = this.clientSessions.get(clientIP);
        
        if (session && (now - session.lastUsed) < this.sessionTimeout) {
            session.lastUsed = now;
            return session.providerIndex;
        }
        
        // Crea nuova sessione
        const availableProviders = this.providers
            .map((p, index) => ({ provider: p, index }))
            .filter(({ provider }) => provider.errorCount < provider.maxErrors)
            .sort((a, b) => a.provider.priority - b.provider.priority);
        
        if (availableProviders.length === 0) return 0;
        
        const selectedIndex = availableProviders[0].index;
        this.clientSessions.set(clientIP, {
            providerIndex: selectedIndex,
            lastUsed: now
        });
        
        return selectedIndex;
    }

    // Cache per richieste identiche
    getCacheKey(payload) {
        // Cache solo per metodi "safe" che non cambiano stato
        const cacheableMethods = [
            'eth_blockNumber',
            'eth_getBalance',
            'eth_getTransactionCount',
            'eth_getCode',
            'eth_call'
        ];
        
        if (!cacheableMethods.includes(payload.method)) {
            return null;
        }
        
        return JSON.stringify({
            method: payload.method,
            params: payload.params
        });
    }

    getCachedResponse(cacheKey) {
        if (!cacheKey) return null;
        
        const cached = this.requestCache.get(cacheKey);
        if (!cached) return null;
        
        const now = Date.now();
        if (now - cached.timestamp > this.cacheTimeout) {
            this.requestCache.delete(cacheKey);
            return null;
        }
        
        return cached.response;
    }

    setCachedResponse(cacheKey, response) {
        if (!cacheKey) return;
        
        this.requestCache.set(cacheKey, {
            response: response,
            timestamp: Date.now()
        });
    }

    startCacheCleanup() {
        setInterval(() => {
            const now = Date.now();
            for (const [key, value] of this.requestCache.entries()) {
                if (now - value.timestamp > this.cacheTimeout) {
                    this.requestCache.delete(key);
                }
            }
            
            // Pulisci anche sessioni scadute
            for (const [clientIP, session] of this.clientSessions.entries()) {
                if (now - session.lastUsed > this.sessionTimeout) {
                    this.clientSessions.delete(clientIP);
                }
            }
        }, 60000); // Ogni minuto
    }

    selectProvider(clientIP = null, preferSync = false) {
        // Se abbiamo un client IP, usa sticky session
        if (clientIP) {
            const sessionIndex = this.getClientSession(clientIP);
            const provider = this.providers[sessionIndex];
            if (provider && provider.errorCount < provider.maxErrors) {
                return provider;
            }
        }
        
        const now = Date.now();
        
        // Filtra provider disponibili
        let availableProviders = this.providers
            .filter(p => p.errorCount < p.maxErrors)
            .sort((a, b) => a.priority - b.priority);
        
        // Se richiesto, preferisci provider più sincronizzati
        if (preferSync && availableProviders.length > 1) {
            const maxHeight = Math.max(...availableProviders.map(p => p.blockHeight));
            availableProviders = availableProviders.filter(p => 
                p.blockHeight === 0 || maxHeight - p.blockHeight <= 1
            );
        }
        
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

    async makeRequest(jsonrpcPayload, maxRetries = 3, clientIP = null) {
        this.requestStats.total++;
        
        // Controlla cache
        const cacheKey = this.getCacheKey(jsonrpcPayload);
        const cachedResponse = this.getCachedResponse(cacheKey);
        if (cachedResponse) {
            console.log(`💾 Cache hit for ${jsonrpcPayload.method}`);
            return { ...cachedResponse, id: jsonrpcPayload.id };
        }
        
        // Determina se questa richiesta ha bisogno di sincronizzazione precisa
        const syncCriticalMethods = [
            'eth_getBlockByNumber',
            'eth_getTransactionByHash',
            'eth_getTransactionReceipt',
            'eth_getLogs'
        ];
        const preferSync = syncCriticalMethods.includes(jsonrpcPayload.method);
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const provider = this.selectProvider(clientIP, preferSync);
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
                
                if (data.error) {
                    if (data.error.code === -32007 || data.error.message.includes('rate limit')) {
                        throw new Error(`Rate limit reached on ${provider.name}`);
                    }
                    
                    // Se è un errore RPC valido, non fare retry
                    if (attempt === maxRetries - 1) {
                        this.requestStats.successful++; // È tecnicamente una risposta valida
                        this.requestStats.byProvider[provider.name].successes++;
                        return data;
                    }
                }
                
                // Successo
                provider.errorCount = Math.max(0, provider.errorCount - 1);
                this.requestStats.successful++;
                this.requestStats.byProvider[provider.name].successes++;
                
                // Salva in cache
                this.setCachedResponse(cacheKey, data);
                
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
                
                // Breve pausa prima del retry con backoff esponenziale
                const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 5000);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
            }
        }
    }

    getHealthStatus() {
        const now = Date.now();
        return {
            providers: this.providers.map(p => ({
                name: p.name,
                available: p.errorCount < p.maxErrors,
                errorCount: p.errorCount,
                maxErrors: p.maxErrors,
                rateLimit: p.rateLimit,
                priority: p.priority,
                blockHeight: p.blockHeight,
                lastHealthCheck: p.lastHealthCheck > 0 ? 
                    new Date(p.lastHealthCheck).toISOString() : 'Never',
                syncStatus: p.blockHeight > 0 ? 'Synced' : 'Unknown'
            })),
            stats: this.requestStats,
            cache: {
                size: this.requestCache.size,
                activeSessions: this.clientSessions.size
            },
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
        const clientIP = req.ip || req.connection.remoteAddress;
        const result = await loadBalancer.makeRequest(req.body, 3, clientIP);
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