interface EnvironmentConfig {
    production: DeploymentEnvironment;
    staging: DeploymentEnvironment;
    development: DeploymentEnvironment;
}

interface DeploymentEnvironment {
    url: string;
    region: string;
    scale: {
        minInstances: number;
        maxInstances: number;
        targetCPUUtilization: number;
    };
    features: {
        cdn: boolean;
        ssl: boolean;
        autoScaling: boolean;
    };
    monitoring: {
        enabled: boolean;
        alerting: boolean;
        logLevel: 'debug' | 'info' | 'warn' | 'error';
    };
}

export const deploymentConfig: EnvironmentConfig = {
    production: {
        url: 'https://supercoder.dev',
        region: 'us-central1',
        scale: {
            minInstances: 2,
            maxInstances: 10,
            targetCPUUtilization: 0.7
        },
        features: {
            cdn: true,
            ssl: true,
            autoScaling: true
        },
        monitoring: {
            enabled: true,
            alerting: true,
            logLevel: 'error'
        }
    },
    staging: {
        url: 'https://staging.supercoder.dev',
        region: 'us-central1',
        scale: {
            minInstances: 1,
            maxInstances: 5,
            targetCPUUtilization: 0.8
        },
        features: {
            cdn: true,
            ssl: true,
            autoScaling: true
        },
        monitoring: {
            enabled: true,
            alerting: true,
            logLevel: 'info'
        }
    },
    development: {
        url: 'https://dev.supercoder.dev',
        region: 'us-central1',
        scale: {
            minInstances: 1,
            maxInstances: 2,
            targetCPUUtilization: 0.9
        },
        features: {
            cdn: false,
            ssl: true,
            autoScaling: false
        },
        monitoring: {
            enabled: true,
            alerting: false,
            logLevel: 'debug'
        }
    }
};
