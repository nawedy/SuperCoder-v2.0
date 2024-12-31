import React from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/layout/Header';
import Footer from '../components/layout/Footer';
import FeaturesSection from '../components/features/FeaturesSection';
import TestimonialsSection from '../components/testimonials/TestimonialsSection';
import PricingSection from '../components/subscription/PricingSection';

export default function Landing() {
  return (
    <div className="bg-gray-900 min-h-screen">
      <Header />
      
      <main>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Hero Section */}
          <div className="pt-12 pb-16 text-center lg:pt-32 px-4 sm:px-6 lg:px-8">
            <h1 className="mx-auto max-w-4xl font-display text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-medium tracking-tight text-white">
              AI-Powered{' '}
              <span className="relative whitespace-normal sm:whitespace-nowrap text-emerald-500 block sm:inline">
                <span className="relative">Natural Language & Terminal Coding</span>
              </span>{' '}
              Made Easy
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-base sm:text-lg tracking-tight text-gray-300 px-4">
              SuperCoder is an advanced AI coding engine designed for real-world tasks that span multiple files.
            </p>
            <div className="mt-8 sm:mt-10 flex flex-col sm:flex-row justify-center gap-4 sm:gap-x-6 px-4">
              <Link
                to="/auth"
                className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 w-full sm:w-auto"
              >
                Get Started
              </Link>
              <Link
                to="/auth"
                className="rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-700 w-full sm:w-auto"
              >
                Login to Account
              </Link>
            </div>
          </div>

          {/* Features Section */}
          <FeaturesSection />

          {/* Testimonials Section */}
          <TestimonialsSection />

          {/* Pricing Section */}
          <PricingSection />
        </div>
      </main>

      <Footer />
    </div>
  );
}