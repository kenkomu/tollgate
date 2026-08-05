// GENERATED FILE — do not edit by hand.
// Regenerate with:  pnpm --filter @tollgate/shared abi
//
// Source: enforcement/out/PolicyEngine.sol/PolicyEngine.json
// This is generated rather than hand-written so the TypeScript view of the contract
// cannot drift from the compiled artifact. Drift here would mean the dashboard
// mislabelling a blocked payment in an audit log, which is the one thing this
// product cannot get wrong.

export const policyEngineAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "usdc",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "USDC",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "availableNow",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint128",
        "internalType": "uint128"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "checkTransfer",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "payee",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "enum PolicyEngine.Reason"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "createPolicy",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "budgetCap",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "perTxCap",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "bucketCapacity",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "refillPerSecond",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getPolicy",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct PolicyEngine.Policy",
        "components": [
          {
            "name": "agent",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "expiry",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "paused",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "exists",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "budgetCap",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "spent",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "perTxCap",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "bucketCapacity",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "refillPerSecond",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "available",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "lastRefill",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isAllowedPayee",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "payee",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ownerOf",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "remainingBudget",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint128",
        "internalType": "uint128"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "revokePolicy",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setAgent",
    "inputs": [
      {
        "name": "newAgent",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setCaps",
    "inputs": [
      {
        "name": "budgetCap",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "perTxCap",
        "type": "uint128",
        "internalType": "uint128"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setExpiry",
    "inputs": [
      {
        "name": "expiry",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setPaused",
    "inputs": [
      {
        "name": "paused",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setPayee",
    "inputs": [
      {
        "name": "payee",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setPayees",
    "inputs": [
      {
        "name": "payees",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setVelocity",
    "inputs": [
      {
        "name": "bucketCapacity",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "refillPerSecond",
        "type": "uint128",
        "internalType": "uint128"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "spend",
    "inputs": [
      {
        "name": "payee",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "spentTotal",
        "type": "uint128",
        "internalType": "uint128"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "AgentRotated",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "previousAgent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newAgent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CapsUpdated",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "budgetCap",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "perTxCap",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ExpiryUpdated",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PauseSet",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "paused",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PayeeSet",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "payee",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicyCreated",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "budgetCap",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "perTxCap",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "bucketCapacity",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "refillPerSecond",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicyRevoked",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Spent",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "payee",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "spentTotal",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "availableAfter",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VelocityUpdated",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "bucketCapacity",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "refillPerSecond",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AgentAlreadyBound",
    "inputs": [
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "existingOwner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "BudgetBelowSpent",
    "inputs": [
      {
        "name": "requested",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "alreadySpent",
        "type": "uint128",
        "internalType": "uint128"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoPolicy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PolicyExists",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PolicyViolation",
    "inputs": [
      {
        "name": "reason",
        "type": "uint8",
        "internalType": "enum PolicyEngine.Reason"
      }
    ]
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
