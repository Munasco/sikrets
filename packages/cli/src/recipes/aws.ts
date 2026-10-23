import { defineTerraformRecipe } from "./types.ts";

// AWS recipes. Credentials come from your AWS profile (`sikrets connect aws`), never from files.

export const vpc = defineTerraformRecipe({
  id: "aws/vpc",
  provider: "aws",
  terraformProvider: "hashicorp/aws",
  summary: "A VPC with one public subnet and an internet gateway",
  estimate: () => "free",
  inputs: {
    cidr: { kind: "string", description: "VPC CIDR block", default: "10.42.0.0/16", pattern: /^\d+\.\d+\.\d+\.\d+\/\d+$/ },
  },
  requires: [],
  outputs: {
    vpc_id: { description: "VPC id", env: "VPC_ID", sensitive: false },
    subnet_id: { description: "Public subnet id", env: "SUBNET_ID", sensitive: false },
  },
  arguments: (i) => ({ name: "var.name", cidr: JSON.stringify(i.cidr) }),
  module: {
    variables: `variable "name" { type = string }
variable "cidr" { type = string }
`,
    main: `data "aws_availability_zones" "available" { state = "available" }

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_hostnames = true
  tags                 = { Name = var.name, ManagedBy = "sikrets" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name, ManagedBy = "sikrets" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.cidr, 8, 0)
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
  tags                    = { Name = "\${var.name}-public", ManagedBy = "sikrets" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "\${var.name}-public", ManagedBy = "sikrets" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}
`,
    outputs: `output "vpc_id" { value = aws_vpc.this.id }
output "subnet_id" { value = aws_subnet.public.id }
`,
  },
});

// Hourly on-demand prices (us-east-1) for the sizes offered, for dry-run estimates only.
const EC2_HOURLY: Record<string, number> = { "t4g.nano": 0.0042, "t4g.micro": 0.0084, "t4g.small": 0.0168, "t4g.medium": 0.0336 };

export const ec2 = defineTerraformRecipe({
  id: "aws/ec2",
  provider: "aws",
  terraformProvider: "hashicorp/aws",
  summary: "An Arm (Graviton) EC2 instance on Amazon Linux 2023, reachable only via SSM Session Manager",
  estimate: (i) => `~$${((EC2_HOURLY[i.size] ?? 0) * 730).toFixed(2)}/mo on-demand + storage`,
  inputs: {
    size: { kind: "choice", description: "Instance size", choices: Object.keys(EC2_HOURLY), default: "t4g.nano" },
    disk: { kind: "number", description: "Root volume in GiB", default: 8, min: 8, max: 200 },
  },
  requires: [{ recipe: "aws/vpc", as: "network" }],
  outputs: {
    instance_id: { description: "Instance id (connect with: aws ssm start-session --target <id>)", env: "INSTANCE_ID", sensitive: false },
    public_ip: { description: "Public IPv4 address", env: "PUBLIC_IP", sensitive: false },
  },
  arguments: (i, dep) => ({
    name: "var.name",
    size: JSON.stringify(i.size),
    disk: String(i.disk),
    subnet_id: dep("network", "subnet_id"),
    vpc_id: dep("network", "vpc_id"),
  }),
  module: {
    variables: `variable "name" { type = string }
variable "size" { type = string }
variable "disk" { type = number }
variable "subnet_id" { type = string }
variable "vpc_id" { type = string }
`,
    main: `data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# No inbound ports: shell access goes through SSM Session Manager, so there is no SSH key to leak.
resource "aws_security_group" "this" {
  name_prefix = "\${var.name}-"
  vpc_id      = var.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = var.name, ManagedBy = "sikrets" }
}

resource "aws_iam_role" "this" {
  name_prefix = "\${var.name}-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "this" {
  name_prefix = "\${var.name}-"
  role        = aws_iam_role.this.name
}

resource "aws_instance" "this" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.size
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.this.id]
  iam_instance_profile   = aws_iam_instance_profile.this.name
  metadata_options { http_tokens = "required" }
  root_block_device {
    volume_size = var.disk
    encrypted   = true
  }
  tags = { Name = var.name, ManagedBy = "sikrets" }
}
`,
    outputs: `output "instance_id" { value = aws_instance.this.id }
output "public_ip" { value = aws_instance.this.public_ip }
`,
  },
});
