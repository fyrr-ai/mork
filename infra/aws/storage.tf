# The Mork bucket (task outputs, hidden tests, agent sessions, Slack
# threads) and the decision timeline. Both belong to this deployment.

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "mork" {
  tags          = local.tags
  bucket        = "${local.dash}-${data.aws_caller_identity.current.account_id}-${data.aws_region.current.region}"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "mork" {
  bucket                  = aws_s3_bucket.mork.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "mork" {
  bucket = aws_s3_bucket.mork.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mork" {
  bucket = aws_s3_bucket.mork.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "mork" {
  bucket = aws_s3_bucket.mork.id
  rule {
    id     = "expire-task-outputs"
    status = "Enabled"
    filter {}
    expiration {
      days = var.bucket_expiration_days
    }
  }
}

# The bucket was called "factory" before.
moved {
  from = aws_s3_bucket.factory
  to   = aws_s3_bucket.mork
}

moved {
  from = aws_s3_bucket_public_access_block.factory
  to   = aws_s3_bucket_public_access_block.mork
}

moved {
  from = aws_s3_bucket_ownership_controls.factory
  to   = aws_s3_bucket_ownership_controls.mork
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.factory
  to   = aws_s3_bucket_server_side_encryption_configuration.mork
}

moved {
  from = aws_s3_bucket_lifecycle_configuration.factory
  to   = aws_s3_bucket_lifecycle_configuration.mork
}

resource "aws_dynamodb_table" "timeline" {
  tags                        = local.tags
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
