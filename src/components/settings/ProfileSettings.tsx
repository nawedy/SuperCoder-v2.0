import React, { useState } from 'react';
import { User, Lock } from 'lucide-react';
import { updateProfile } from '../../lib/api';
import type { Profile } from '../../types/database';

interface ProfileSettingsProps {
  profile: Profile;
  onUpdate: (profile: Profile) => void;
}

export default function ProfileSettings({ profile, onUpdate }: ProfileSettingsProps) {
  const [fullName, setFullName] = useState(profile.full_name || '');
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(profile.two_factor_enabled);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await updateProfile({
        id: profile.id,
        full_name: fullName,
        two_factor_enabled: twoFactorEnabled
      });
      onUpdate(updated);
    } catch (error) {
      console.error('Failed to update profile:', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h2 className="text-xl font-semibold text-white mb-6">Profile Settings</h2>
      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="flex items-center gap-2 text-gray-300 mb-2">
            <User className="h-4 w-4" />
            Full Name
          </label>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full bg-gray-700 text-white rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </div>

        <div>
          <label className="flex items-center gap-2 text-gray-300">
            <Lock className="h-4 w-4" />
            Two-Factor Authentication
          </label>
          <div className="mt-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={twoFactorEnabled}
                onChange={(e) => setTwoFactorEnabled(e.target.checked)}
                className="form-checkbox h-4 w-4 text-emerald-600 rounded focus:ring-emerald-500 bg-gray-700 border-gray-600"
              />
              <span className="text-gray-300">Enable 2FA</span>
            </label>
          </div>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700 text-white rounded-lg px-4 py-2"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </form>
    </div>
  );
}