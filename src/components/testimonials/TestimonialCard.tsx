import React from 'react';

interface TestimonialCardProps {
  name: string;
  role: string;
  company: string;
  image: string;
  content: string;
}

export default function TestimonialCard({ name, role, company, image, content }: TestimonialCardProps) {
  return (
    <div className="bg-gray-800 p-6 rounded-lg">
      <div className="flex items-center mb-4">
        <img
          src={image}
          alt={name}
          className="h-12 w-12 rounded-full object-cover"
        />
        <div className="ml-4">
          <h4 className="text-white font-semibold">{name}</h4>
          <p className="text-gray-400 text-sm">
            {role} at {company}
          </p>
        </div>
      </div>
      <p className="text-gray-300">{content}</p>
    </div>
  );
}