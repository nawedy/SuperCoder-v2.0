interface PipelineConfig {
    production: EnvironmentConfig;
    staging: EnvironmentConfig;
    development: EnvironmentConfig;
}

interface EnvironmentConfig {
    vercel: {
        deploymentRegions: string[];
        buildSettings: {
            framework: string;
            nodeVersion: string;
            installCommand: string;
            buildCommand: string;
            outputDirectory: string;
        };
    };
    supabase: {
        db: {
            poolSize: number;
            maxConnections: number;
        };
        auth: {
            jwtExpiry: number;
            autoConfirm: boolean;
        };
        functions: {
            timeout: number;
            memory: number;
        };
    };
    gcp: {
        region: string;
        services: {
            enabled: string[];
            configurations: Record<string, any>;
        };
        monitoring: {
            alertPolicies: any[];
            loggingConfig: any;
        };
    };
}

export const pipelineConfig: PipelineConfig = {
    production: {
        vercel: {
            deploymentRegions: ['sfo1', 'iad1'],
            buildSettings: {
                framework: 'next',
                nodeVersion: '18.x',
                installCommand: 'npm install',
                buildCommand: 'npm run build',
                outputDirectory: 'dist'
            }
        },
        supabase: {
            db: {
                poolSize: 20,
                maxConnections: 100
            },
            auth: {
                jwtExpiry: 3600,
                autoConfirm: false
            },
            functions: {
                timeout: 60,
                memory: 1024
            }
        },
        gcp: {
            region: 'us-central1',
            services: {
                enabled: [
                    'cloudfunctions.googleapis.com',
                    'cloudmonitoring.googleapis.com',
                    'cloudtrace.googleapis.com'
                ],
                configurations: {
                    // Service-specific configurations
                }
            },
            monitoring: {
                alertPolicies: [],
                loggingConfig: {
                    // Logging configurations
                }
            }
        }
    },
    staging: {
        // Similar to production but with different values
        // ...staging configuration...
    },
    development: {
        // Development environment configuration
        // ...development configuration...
    }
};
