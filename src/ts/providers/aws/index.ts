// providers/aws/index.ts — AWS Provider Plugin
import { ProviderPlugin } from "../../sdk/index.js";
import { AWS_REG, CAT, CAT_LABEL, awsBlockHeight } from "./catalog.js";
import { awsCommands } from "./cli.js";
import { awsConsoleUrl, AWS_CONSOLE_HOSTS } from "./console.js";
import { awsRuleSet, awsDescribeRule, awsRuleKey } from "./rules.js";
import { startAwsPlacement } from "./placement.js";

export const awsProvider: ProviderPlugin = {
  id: "aws",
  name: "AWS",
  sourceAddresses: ["registry.terraform.io/hashicorp/aws", "registry.opentofu.org/hashicorp/aws"],
  localNames: ["aws"],
  typePrefix: "aws_",
  cloudLabel: "AWS Cloud",
  globalNote: "account-level",
  unplacedNote: "no vpc or subnet reference",
  settingKeys: ["region"],
  cliName: "AWS CLI",
  consoleName: "AWS console",
  consoleHosts: AWS_CONSOLE_HOSTS,
  catalog: AWS_REG,
  categories: CAT,
  categoryLabels: CAT_LABEL,
  cli: awsCommands,
  consoleUrl: awsConsoleUrl,
  /* a VPC endpoint's service name, shortened: "com.amazonaws.eu-west-1.s3" -> "s3" */
  tileSubtitle: function(r, value) {
    return r.type === "aws_vpc_endpoint" ? (value.split(".").slice(3).join(".") || value) : value;
  },
  sizing: { blockHeight: awsBlockHeight },
  rules: {
    ruleSet: awsRuleSet,
    describe: awsDescribeRule,
    key: awsRuleKey
  },
  placement: { start: startAwsPlacement }
};

export default awsProvider;
