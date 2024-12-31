import React from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import LanguageButton from './LanguageButton';
import { SUPPORTED_LANGUAGES } from '../../constants/languages';

interface LanguageModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function LanguageModal({ isOpen, onClose }: LanguageModalProps) {
  const { i18n, t } = useTranslation();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-900 rounded-xl p-6 max-w-md w-full mx-4" dir="auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold text-white">
            {t('settings.selectLanguage')}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {SUPPORTED_LANGUAGES.map((lang) => (
            <LanguageButton
              key={lang.code}
              code={lang.code}
              name={lang.name}
              selected={i18n.language === lang.code}
              onClick={() => {
                i18n.changeLanguage(lang.code);
                onClose();
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}