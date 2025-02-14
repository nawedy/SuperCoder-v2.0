export const environment = {
    production: process.env.NODE_ENV === 'production',
    supabase: {
        url: process.env.SUPABASE_URL || '',
        anonKey: process.env.SUPABASE_ANON_KEY || '',
    },
    ai: {
        endpoint: process.env.AI_ENDPOINT || '',
        version: process.env.AI_MODEL_VERSION || 'v1',
    },
    monitoring: {
        enabled: true,
        logLevel: process.env.LOG_LEVEL || 'info',
    }
};
