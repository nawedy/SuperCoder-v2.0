import React from 'react';
import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { useLanguage } from '../../hooks/useLanguage';
import type { Profile } from '../../types/database';

interface LanguageSettingsProps {
  profile: Profile;
}

export default function LanguageSettings({ profile }: LanguageSettingsProps) {
  const { t } = useTranslation();
  const { currentLanguage } = useLanguage();

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h2 className="text-xl font-semibold text-white mb-6">
        {t('settings.language')}
      </h2>
      <div className="space-y-4">
        <div>
          <label className="flex items-center gap-2 text-gray-300 mb-2">
            <Globe className="h-4 w-4" />
            {t('settings.preferredLanguage')}
          </label>
          <div className="w-full max-w-xs">
            <LanguageSelector />
          </div>
          <p className="mt-2 text-sm text-gray-400">
            {t('settings.languageDescription')}
          </p>
        </div>
      </div>
    </div>
  );
}