import React from 'react';
import { useTranslation } from 'react-i18next';
import ProfileSettings from '../components/settings/ProfileSettings';
import LanguageSettings from '../components/settings/LanguageSettings';
import APIKeySettings from '../components/settings/APIKeySettings';
import { useProfile } from '../hooks/useProfile';

export default function Settings() {
  const { t } = useTranslation();
  const { profile, loading, error } = useProfile();

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white">{t('common.loading')}</div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white">{t('common.error')}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <h1 className="text-2xl font-bold text-white mb-8">{t('settings.title')}</h1>
        <div className="space-y-6">
          <ProfileSettings profile={profile} />
          <LanguageSettings profile={profile} />
          <APIKeySettings models={[]} userKeys={[]} onSave={() => {}} />
        </div>
      </div>
    </div>
  );
}