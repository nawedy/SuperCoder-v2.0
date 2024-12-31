import React from 'react';
import { Link } from 'react-router-dom';
import { Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import LanguageSelector from '../language/LanguageSelector';

export default function Header() {
  const { t } = useTranslation();

  return (
    <header className="bg-gray-900 border-b border-gray-800">
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center">
            <Link to="/" className="flex items-center space-x-2">
              <Terminal className="h-8 w-8 text-emerald-500" />
              <span className="text-xl font-bold text-white">SuperCoder</span>
            </Link>
          </div>
          <div className="flex items-center space-x-4">
            <LanguageSelector />
            <Link
              to="/auth"
              className="text-gray-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium"
            >
              {t('auth.signIn')}
            </Link>
            <Link
              to="/auth"
              className="bg-emerald-600 hover:bg-emerald-700 px-4 py-2 rounded-md text-sm font-medium text-white"
            >
              {t('auth.signUp')}
            </Link>
          </div>
        </div>
      </nav>
    </header>
  );
}