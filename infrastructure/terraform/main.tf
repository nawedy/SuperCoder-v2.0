terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 4.80.0"
    }
  }
  backend "gcs" {
    bucket = "supercode-terraform-state"
    prefix = "terraform/state"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

variable "project_id" {
  description = "The GCP project ID"
  type        = string
}

variable "region" {
  description = "The GCP region to deploy resources"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "The GCP zone to deploy resources"
  type        = string
  default     = "us-central1-a"
}

variable "environment" {
  description = "The deployment environment (development, staging, production)"
  type        = string
  default     = "staging"
  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "Environment must be one of: development, staging, production."
  }
}

variable "app_name" {
  description = "The name of the application"
  type        = string
  default     = "supercode"
}

# Create GCS bucket for deployment artifacts
resource "google_storage_bucket" "deployment_bucket" {
  name     = "${var.app_name}-${var.environment}-artifacts"
  location = var.region
  
  versioning {
    enabled = true
  }
  
  uniform_bucket_level_access = true
  
  encryption {
    default_kms_key_name = google_kms_crypto_key.bucket_key.id
  }
  
  lifecycle_rule {
    condition {
      age = 90
    }
    action {
      type = "Delete"
    }
  }
}

# KMS Key for bucket encryption
resource "google_kms_key_ring" "keyring" {
  name     = "${var.app_name}-${var.environment}-keyring"
  location = var.region
}

resource "google_kms_crypto_key" "bucket_key" {
  name     = "${var.app_name}-${var.environment}-key"
  key_ring = google_kms_key_ring.keyring.id
  
  lifecycle {
    prevent_destroy = true
  }
}

# Cloud Run service for the application
resource "google_cloud_run_service" "app_service" {
  name     = "${var.app_name}-${var.environment}"
  location = var.region
  
  template {
    spec {
      containers {
        image = "gcr.io/${var.project_id}/${var.app_name}:latest"
        
        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }
        
        env {
          name  = "NODE_ENV"
          value = var.environment
        }
        
        env {
          name  = "LOG_LEVEL"
          value = "info"
        }
        
        # Reference to secrets
        env {
          name  = "JWT_SECRET"
          value_from {
            secret_key_ref {
              name = "jwt-secret"
              key  = "latest"
            }
          }
        }
      }
    }
  }
  
  traffic {
    percent         = 100
    latest_revision = true
  }
}

# Set up domain mapping
resource "google_cloud_run_domain_mapping" "app_domain" {
  name     = "api.${var.app_name}.ai"
  location = var.region
  
  metadata {
    namespace = var.project_id
  }
  
  spec {
    route_name = google_cloud_run_service.app_service.name
  }
}

# Make the Cloud Run service publicly accessible
data "google_iam_policy" "noauth" {
  binding {
    role = "roles/run.invoker"
    members = [
      "allUsers",
    ]
  }
}

resource "google_cloud_run_service_iam_policy" "noauth" {
  location    = google_cloud_run_service.app_service.location
  project     = google_cloud_run_service.app_service.project
  service     = google_cloud_run_service.app_service.name
  policy_data = data.google_iam_policy.noauth.policy_data
}

# Firestore database for application data
resource "google_firestore_database" "app_database" {
  name        = "${var.app_name}-${var.environment}"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  
  concurrency_mode = "OPTIMISTIC"
  
  app_engine_integration_mode = "DISABLED"
}

# Secret Manager for sensitive information
resource "google_secret_manager_secret" "jwt_secret" {
  secret_id = "jwt-secret-${var.environment}"
  
  replication {
    automatic = true
  }
}

resource "google_secret_manager_secret_version" "jwt_secret_version" {
  secret      = google_secret_manager_secret.jwt_secret.id
  secret_data = "super-secure-jwt-secret-that-should-be-changed"
}

# Cloud Load Balancing for the frontend
resource "google_compute_global_address" "lb_address" {
  name = "${var.app_name}-${var.environment}-lb-address"
}

# SSL certificate for HTTPS
resource "google_compute_managed_ssl_certificate" "app_certificate" {
  name = "${var.app_name}-${var.environment}-cert"
  
  managed {
    domains = ["${var.app_name}.ai", "www.${var.app_name}.ai", "api.${var.app_name}.ai"]
  }
}

# Outputs
output "service_url" {
  value = google_cloud_run_service.app_service.status[0].url
}

output "bucket_name" {
  value = google_storage_bucket.deployment_bucket.name
}

output "database_name" {
  value = google_firestore_database.app_database.name
}

output "lb_ip_address" {
  value = google_compute_global_address.lb_address.address
} 