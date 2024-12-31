import React from 'react';
import { Terminal, Mail, Phone } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="bg-gray-900 border-t border-gray-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-1">
            <div className="flex items-center space-x-2">
              <Terminal className="h-6 w-6 sm:h-8 sm:w-8 text-emerald-500" />
              <span className="text-lg sm:text-xl font-bold text-white">SuperCoder</span>
            </div>
            <p className="mt-4 text-sm sm:text-base text-gray-400">
              Revolutionizing coding with AI-powered assistance and natural language processing.
            </p>
          </div>

          {/* Product */}
          <div>
            <h3 className="text-white font-semibold mb-4">Product</h3>
            <ul className="space-y-2 text-sm sm:text-base">
              <li><a href="#features" className="text-gray-400 hover:text-white">Features</a></li>
              <li><a href="#pricing" className="text-gray-400 hover:text-white">Pricing</a></li>
              <li><a href="#testimonials" className="text-gray-400 hover:text-white">Testimonials</a></li>
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="text-white font-semibold mb-4">Company</h3>
            <ul className="space-y-2 text-sm sm:text-base">
              <li><a href="#about" className="text-gray-400 hover:text-white">About</a></li>
              <li><a href="#careers" className="text-gray-400 hover:text-white">Careers</a></li>
              <li><a href="#blog" className="text-gray-400 hover:text-white">Blog</a></li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h3 className="text-white font-semibold mb-4">Contact</h3>
            <ul className="space-y-2 text-sm sm:text-base">
              <li>
                <a href="mailto:support@supercoder.ai" className="text-gray-400 hover:text-white flex items-center gap-2">
                  <Mail className="h-4 w-4" />
                  support@supercoder.ai
                </a>
              </li>
              <li>
                <a href="tel:+1234567890" className="text-gray-400 hover:text-white flex items-center gap-2">
                  <Phone className="h-4 w-4" />
                  (123) 456-7890
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-8 pt-8 border-t border-gray-800">
          <div className="text-center text-sm sm:text-base text-gray-400">
            <p>&copy; {new Date().getFullYear()} SuperCoder. All rights reserved.</p>
          </div>
        </div>
      </div>
    </footer>
  );
}