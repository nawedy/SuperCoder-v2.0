#!/bin/bash
# SuperCode Deployment Script

set -e

# Default values
ENVIRONMENT="staging"
VERSION=$(git describe --tags --always --dirty)
GCP_REGION="us-central1"
GCP_ZONE="us-central1-a"
GCP_PROJECT_ID="supercode-project" # Change this to your actual project ID
DOMAIN_NAME="supercode.ai"
LOG_LEVEL="info"

# Display help message
function show_help {
  echo "SuperCode Deployment Script"
  echo "Usage: ./deploy.sh [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  -e, --env ENVIRONMENT     Deployment environment (development, staging, production)"
  echo "  -v, --version VERSION     Version to deploy (default: latest git tag)"
  echo "  -p, --project PROJECT_ID  GCP project ID (default: supercode-project)"
  echo "  -r, --region REGION       GCP region (default: us-central1)"
  echo "  -z, --zone ZONE           GCP zone (default: us-central1-a)"
  echo "  -d, --domain DOMAIN       Domain name (default: supercode.ai)"
  echo "  -l, --log-level LEVEL     Log level (default: info)"
  echo "  -h, --help                Show this help message"
  echo ""
  exit 0
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  key="$1"
  case $key in
    -e|--env)
      ENVIRONMENT="$2"
      shift
      shift
      ;;
    -v|--version)
      VERSION="$2"
      shift
      shift
      ;;
    -p|--project)
      GCP_PROJECT_ID="$2"
      shift
      shift
      ;;
    -r|--region)
      GCP_REGION="$2"
      shift
      shift
      ;;
    -z|--zone)
      GCP_ZONE="$2"
      shift
      shift
      ;;
    -d|--domain)
      DOMAIN_NAME="$2"
      shift
      shift
      ;;
    -l|--log-level)
      LOG_LEVEL="$2"
      shift
      shift
      ;;
    -h|--help)
      show_help
      ;;
    *)
      echo "Unknown option: $1"
      show_help
      ;;
  esac
done

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(development|staging|production)$ ]]; then
  echo "Error: Environment must be one of: development, staging, production"
  exit 1
fi

echo "======================================================"
echo "SuperCode Deployment - $ENVIRONMENT Environment"
echo "======================================================"
echo "Version:     $VERSION"
echo "GCP Project: $GCP_PROJECT_ID"
echo "GCP Region:  $GCP_REGION"
echo "GCP Zone:    $GCP_ZONE"
echo "Domain:      $DOMAIN_NAME"
echo "Log Level:   $LOG_LEVEL"
echo "======================================================"
echo ""

# Confirm deployment
read -p "Proceed with deployment? (y/n): " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Deployment aborted."
  exit 0
fi

# Start deployment
echo "Starting deployment process..."

# 1. Check prerequisites
echo "[1/8] Checking prerequisites..."
if ! command -v gcloud &> /dev/null; then
  echo "Error: Google Cloud SDK is not installed or not in PATH"
  exit 1
fi

if ! command -v terraform &> /dev/null; then
  echo "Error: Terraform is not installed or not in PATH"
  exit 1
fi

if ! command -v kubectl &> /dev/null; then
  echo "Error: kubectl is not installed or not in PATH"
  exit 1
fi

if ! command -v docker &> /dev/null; then
  echo "Error: Docker is not installed or not in PATH"
  exit 1
fi

# 2. Build application
echo "[2/8] Building application..."
npm run build

# 3. Run tests
echo "[3/8] Running tests..."
npm test
npm run test:integration
npm run benchmark -- --tag fast

# 4. Build Docker image
echo "[4/8] Building Docker image..."
docker build -t supercode-api:$VERSION .

# 5. Configure Google Cloud
echo "[5/8] Configuring Google Cloud..."
# Set default project
gcloud config set project $GCP_PROJECT_ID
gcloud config set compute/region $GCP_REGION
gcloud config set compute/zone $GCP_ZONE

# Get or create GCR repository
echo "Ensuring GCR repository access..."
# Make sure Docker is authenticated with GCR
gcloud auth configure-docker gcr.io

# Tag and push Docker image
echo "Pushing Docker image to GCR..."
docker tag supercode-api:$VERSION gcr.io/$GCP_PROJECT_ID/supercode-api:$VERSION
docker push gcr.io/$GCP_PROJECT_ID/supercode-api:$VERSION

# 6. Apply Terraform
echo "[6/8] Applying Terraform configuration..."
cd infrastructure/terraform
terraform init
terraform workspace select $ENVIRONMENT || terraform workspace new $ENVIRONMENT
terraform apply -var="environment=$ENVIRONMENT" -var="project_id=$GCP_PROJECT_ID" -var="region=$GCP_REGION" -var="zone=$GCP_ZONE" -var="app_name=supercode" -auto-approve
cd ../..

# 7. Deploy to Kubernetes (GKE)
echo "[7/8] Deploying to Kubernetes..."

# Get cluster credentials
gcloud container clusters get-credentials supercode-$ENVIRONMENT --region $GCP_REGION

# Export environment variables for Kubernetes manifests
export ENVIRONMENT=$ENVIRONMENT
export GCR_REPOSITORY_URI="gcr.io/$GCP_PROJECT_ID/supercode-api"
export IMAGE_TAG=$VERSION
export DOMAIN_NAME=$DOMAIN_NAME
export LOG_LEVEL=$LOG_LEVEL
export GCP_REGION=$GCP_REGION
export DATABASE_NAME=$(terraform -chdir=infrastructure/terraform output -raw database_name)
export JWT_SECRET=$(gcloud secrets versions access latest --secret=jwt-secret-$ENVIRONMENT 2>/dev/null || echo "jwt-secret-placeholder")

# Apply Kubernetes manifests
envsubst < infrastructure/kubernetes/deployment.yaml | kubectl apply -f -

# 8. Verify deployment
echo "[8/8] Verifying deployment..."
kubectl rollout status deployment/supercode-api -n supercode-$ENVIRONMENT

# Wait for ingress to be available
echo "Waiting for ingress to be available..."
sleep 30

# Check if ingress is available
INGRESS_HOST=$(kubectl get ingress supercode-api -n supercode-$ENVIRONMENT -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
if [[ -z "$INGRESS_HOST" ]]; then
  echo "Warning: Ingress host is not available yet. Check manually later."
else
  echo "Ingress available at: $INGRESS_HOST"
  echo "Testing API endpoint..."
  curl -s -o /dev/null -w "%{http_code}" https://api.$DOMAIN_NAME/health || echo "API health check failed"
fi

# Cloud Run alternative deployment
# We could also deploy directly to Cloud Run instead of GKE if simpler deployment is preferred
# Uncomment this section to enable Cloud Run deployment
# echo "Deploying to Cloud Run..."
# gcloud run deploy supercode-api \
#   --image gcr.io/$GCP_PROJECT_ID/supercode-api:$VERSION \
#   --platform managed \
#   --region $GCP_REGION \
#   --allow-unauthenticated \
#   --set-env-vars="NODE_ENV=$ENVIRONMENT,LOG_LEVEL=$LOG_LEVEL" \
#   --update-secrets=JWT_SECRET=jwt-secret-$ENVIRONMENT:latest

echo ""
echo "======================================================"
echo "Deployment completed successfully!"
echo "======================================================"
echo "Environment:  $ENVIRONMENT"
echo "Version:      $VERSION"
echo "GCP Project:  $GCP_PROJECT_ID"
echo "API Endpoint: https://api.$DOMAIN_NAME"
echo "======================================================" 