import React from 'react';
import { Check } from 'lucide-react';

interface PricingFeature {
  text: string;
  included: boolean;
}

interface PricingCardProps {
  title: string;
  price: string;
  features: PricingFeature[];
  isPopular?: boolean;
  onSelect: () => void;
}

export default function PricingCard({ title, price, features, isPopular, onSelect }: PricingCardProps) {
  return (
    <div className={`bg-gray-800 rounded-xl p-6 ${isPopular ? 'ring-2 ring-emerald-500' : ''}`}>
      {isPopular && (
        <span className="bg-emerald-500 text-white px-3 py-1 rounded-full text-sm font-medium">
          Most Popular
        </span>
      )}
      <h3 className="text-xl font-semibold text-white mt-4">{title}</h3>
      <div className="mt-4 flex items-baseline text-white">
        <span className="text-4xl font-bold">${price}</span>
        <span className="ml-1 text-gray-400">/month</span>
      </div>
      <ul className="mt-6 space-y-4">
        {features.map((feature, index) => (
          <li key={index} className="flex items-center gap-3">
            <Check className={`h-5 w-5 ${feature.included ? 'text-emerald-500' : 'text-gray-500'}`} />
            <span className={feature.included ? 'text-white' : 'text-gray-500'}>
              {feature.text}
            </span>
          </li>
        ))}
      </ul>
      <button
        onClick={onSelect}
        className={`mt-8 w-full rounded-lg px-4 py-2 font-medium ${
          isPopular
            ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
            : 'bg-gray-700 hover:bg-gray-600 text-white'
        }`}
      >
        Select Plan
      </button>
    </div>
  );
}