import { KMSKeyRing } from '@google-cloud/kms';

export interface SecurityConfig {
    encryption: {
        algorithm: string;
        keySize: number;
        kmsKeyRing: KMSKeyRing;
    };
    authentication: {
        mfaRequired: boolean;
        sessionTimeout: number;
        maxLoginAttempts: number;
    };
    privacy: {
        dlpEnabled: boolean;
        anonymizationLevel: 'high' | 'medium' | 'low';
    };
}

export const defaultSecurityConfig: SecurityConfig = {
    encryption: {
        algorithm: 'AES-256-GCM',
        keySize: 256,
        kmsKeyRing: process.env.KMS_KEYRING as unknown as KMSKeyRing
    },
    authentication: {
        mfaRequired: true,
        sessionTimeout: 3600, // 1 hour
        maxLoginAttempts: 3
    },
    privacy: {
        dlpEnabled: true,
        anonymizationLevel: 'high'
    }
};
