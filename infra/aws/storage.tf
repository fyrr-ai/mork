# The factory bucket (task outputs, hidden tests, agent sessions, Slack
# threads) and the decision timeline. Both belong to this deployment.

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "factory" {
  bucket        = "${local.dash}-${data.aws_caller_identity.current.account_id}-${data.aws_region.current.region}"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "factory" {
  bucket                  = aws_s3_bucket.factory.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "factory" {
  bucket = aws_s3_bucket.factory.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "factory" {
  bucket = aws_s3_bucket.factory.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "factory" {
  bucket = aws_s3_bucket.factory.id
  rule {
    id     = "expire-task-outputs"
    status = "Enabled"
    filter {}
    expiration {
      days = var.bucket_expiration_days
    }
  }
}

resource "aws_dynamodb_table" "timeline" {
  name                        = "${local.dash}-timeline"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = !var.force_destroy

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  server_side_encryption {
    enabled = true
  }

  point_in_time_recovery {
    enabled = true
  }
}
