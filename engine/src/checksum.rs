use serde::Serialize;
use sha2::Digest;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum Algorithm {
    #[serde(rename = "CRC32")]
    Crc32,
    #[serde(rename = "BLAKE3")]
    Blake3,
    #[serde(rename = "MD5")]
    Md5,
    #[serde(rename = "SHA-1")]
    Sha1,
    #[serde(rename = "SHA-256")]
    Sha256,
    #[serde(rename = "xxHash3-64")]
    Xxh3,
}

pub type Checksums = BTreeMap<Algorithm, String>;

pub enum Hasher {
    Crc32(crc32fast::Hasher),
    Blake3(Box<blake3::Hasher>),
    Md5(md5::Md5),
    Sha1(sha1::Sha1),
    Sha256(sha2::Sha256),
    Xxh3(Box<xxhash_rust::xxh3::Xxh3>),
}

impl Hasher {
    pub fn new(algorithm: Algorithm) -> Self {
        match algorithm {
            Algorithm::Crc32 => Self::Crc32(crc32fast::Hasher::new()),
            Algorithm::Blake3 => Self::Blake3(Box::new(blake3::Hasher::new())),
            Algorithm::Md5 => Self::Md5(md5::Md5::new()),
            Algorithm::Sha1 => Self::Sha1(sha1::Sha1::new()),
            Algorithm::Sha256 => Self::Sha256(sha2::Sha256::new()),
            Algorithm::Xxh3 => Self::Xxh3(Box::new(xxhash_rust::xxh3::Xxh3::new())),
        }
    }

    pub fn update(&mut self, bytes: &[u8]) {
        match self {
            Self::Crc32(hash) => hash.update(bytes),
            Self::Blake3(hash) => { hash.update(bytes); }
            Self::Md5(hash) => hash.update(bytes),
            Self::Sha1(hash) => hash.update(bytes),
            Self::Sha256(hash) => hash.update(bytes),
            Self::Xxh3(hash) => hash.update(bytes),
        }
    }

    pub fn finish(self) -> String {
        match self {
            Self::Crc32(hash) => format!("{:08x}", hash.finalize()),
            Self::Blake3(hash) => hash.finalize().to_hex().to_string(),
            Self::Md5(hash) => format!("{:x}", hash.finalize()),
            Self::Sha1(hash) => format!("{:x}", hash.finalize()),
            Self::Sha256(hash) => format!("{:x}", hash.finalize()),
            Self::Xxh3(hash) => format!("{:016x}", hash.digest()),
        }
    }
}
